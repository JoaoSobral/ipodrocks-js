/**
 * @vitest-environment node
 *
 * Regressions from the 2026-09-28 security findings: the podcast pipeline and
 * the device row it trusts.
 *
 * Three findings meet here, and they share one shape — a value a web guest can
 * write (a device's `mount_path` and `podcast_folder`, a podcast `feedId`)
 * reached a server filesystem sink that treated it as server-derived:
 *
 *  - `cleanupEpisodeArtifacts()` did `fs.unlinkSync(join(mount_path, rel))` for
 *    every device, a browser-held one included, after `device:update` had let
 *    the guest point that device's `mount_path` at a real server directory.
 *  - `device:update` also wrote `autoPodcastsEnabled: true` on a remote device,
 *    straight past `autoPodcastBlock()`.
 *  - `podcast:subscribe` stored a string `feedId`, which INTEGER affinity keeps
 *    as TEXT and `getEpisodeDir()` joined out of the podcasts root.
 *
 * And one availability finding: `refreshAll()` let one subscription's failure
 * stop every subscription after it, and overlapping runs stacked.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  createTmpDir,
  cleanupTmp,
  type TestDb,
} from "../harness";

vi.mock("../../main/podcasts/podcast-feed-import", () => ({
  fetchAndParseFeed: vi.fn(),
}));
vi.mock("../../main/podcasts/podcast-downloader", () => ({
  downloadEpisode: vi.fn().mockResolvedValue({ localPath: "/dev/null" }),
}));

import {
  assertPodcastFeedId,
  containPodcastDevicePath,
  getEpisodeDir,
  getEpisodePath,
} from "../../main/podcasts/podcast-storage";
import {
  deleteEpisodes,
  subscribe,
  unsubscribe,
} from "../../main/podcasts/podcast-subscriptions";
import { getEpisodes } from "../../main/podcasts/podcast-index-client";
import { refreshAll } from "../../main/podcasts/podcast-refresh";
import { fetchAndParseFeed } from "../../main/podcasts/podcast-feed-import";
import { DevicesCore, sanitizeContentFolder } from "../../main/devices/devices-core";
import {
  registerDeviceTransport,
  resetDeviceTransports,
  webDeviceRoot,
  type DeviceRpcTransport,
} from "../../main/devices/fs";
import type { PodcastSearchResult } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

// ---------------------------------------------------------------------------
// feedId is a path component and an API query value.
// ---------------------------------------------------------------------------
describe("podcast feedId cannot escape the podcasts root", () => {
  it("refuses a traversal string and every other non-integer shape", () => {
    for (const bad of [
      "1/../../../tmp/x",
      "920666&id=../../x",
      "42", // a string, even a numeric one: the caller would store it as TEXT
      "",
      NaN,
      Infinity,
      1.5,
      0,
      null,
      undefined,
      {},
    ]) {
      expect(() => assertPodcastFeedId(bad as unknown), String(bad)).toThrow(/invalid podcast feed id/);
    }
    expect(() => getEpisodeDir("../../../../tmp/x" as unknown as number)).toThrow();
    expect(() => getEpisodePath("1/../../x" as unknown as number, 1, ".mp3")).toThrow();
  });

  it("accepts a Podcast Index id and an RSS (negative) id, inside the root", () => {
    expect(assertPodcastFeedId(920666)).toBe(920666);
    // `stableRssFeedId()` ids are negative on purpose; they must keep working.
    expect(assertPodcastFeedId(-123456)).toBe(-123456);
    const dir = getEpisodeDir(920666);
    expect(dir.endsWith(path.join("auto-podcasts", "920666"))).toBe(true);
    expect(path.basename(getEpisodePath(-5, 7, "mp3"))).toBe("7.mp3");
  });

  it("the Podcast Index client refuses a non-integer id before any request", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(getEpisodes("1&max=1000" as unknown as number, 50, "k", "s")).rejects.toThrow(
        /invalid Podcast Index feed id/
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the Podcast Index client encodes a valid id as exactly one parameter", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    try {
      await getEpisodes(920666, 50, "k", "s");
      const url = new URL(String(spy.mock.calls[0][0]));
      expect(url.searchParams.getAll("id")).toEqual(["920666"]);
      expect(url.searchParams.get("max")).toBe("50");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("subscribe() validates the feed it is handed", () => {
  let db: TestDb;
  beforeEach(() => {
    if (canRunDbTests) db = createTestDb();
  });
  afterEach(() => closeDb(db));

  const feed = (feedId: unknown): PodcastSearchResult =>
    ({
      feedId,
      title: "Show",
      author: "",
      description: "",
      imageUrl: "",
      feedUrl: "https://example.com/feed.xml",
      episodeCount: 1,
    }) as unknown as PodcastSearchResult;

  itDb("refuses a traversal feedId and inserts no row", () => {
    for (const bad of ["../../../../tmp/x&id=920666", "920666/../../x", "42", -7, 0]) {
      expect(() => subscribe(db, feed(bad))).toThrow();
    }
    const n = (db.prepare("SELECT COUNT(*) AS n FROM podcast_subscriptions").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  itDb("the control: a real Podcast Index id subscribes", () => {
    const sub = subscribe(db, feed(920666));
    expect(sub.feedId).toBe(920666);
    const row = db.prepare("SELECT typeof(feed_id) AS t FROM podcast_subscriptions").get() as { t: string };
    expect(row.t).toBe("integer");
  });
});

// ---------------------------------------------------------------------------
// Device copies are deleted through the device, and only inside its podcast
// folder.
// ---------------------------------------------------------------------------
describe("podcast cleanup never unlinks a server file through a device row", () => {
  let db: TestDb;
  let tmp: string;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    tmp = createTmpDir("podcast-cleanup-");
  });
  afterEach(() => {
    resetDeviceTransports();
    closeDb(db);
    if (tmp) cleanupTmp(tmp);
  });

  function seedEpisode(): { subId: number; epId: number } {
    const subId = Number(
      db
        .prepare(
          `INSERT INTO podcast_subscriptions (feed_id, title, feed_url, source, auto_count)
           VALUES (-1, 'iPodRocks', 'https://x/feed', 'rss', 1)`
        )
        .run().lastInsertRowid
    );
    const epId = Number(
      db
        .prepare(
          `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
           VALUES (?, 'g', 'ipodrocks-server', 'https://x/e.db', 'ready')`
        )
        .run(subId).lastInsertRowid
    );
    return { subId, epId };
  }

  function addDevice(opts: { transport: "local" | "web"; mountPath: string; podcastFolder: string }): number {
    const mode = db.prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'").get() as { id: number };
    return Number(
      db
        .prepare(
          `INSERT INTO devices (name, mount_path, podcast_folder, default_transfer_mode_id, transport)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(`dev-${Math.random()}`, opts.mountPath, opts.podcastFolder, mode.id, opts.transport)
        .lastInsertRowid
    );
  }

  /** The finding's end state: a web device whose mount_path a guest rewrote. */
  function plantVictim(): string {
    const victimDir = path.join(tmp, "config", "iPodRocks");
    fs.mkdirSync(victimDir, { recursive: true });
    const victim = path.join(victimDir, "ipodrocks-server.db");
    fs.writeFileSync(victim, "the server's own database");
    return victim;
  }

  itDb("a web device's rewritten mount_path is never joined onto the server fs", () => {
    const victim = plantVictim();
    const { epId } = seedEpisode();
    const devId = addDevice({ transport: "web", mountPath: path.join(tmp, "config"), podcastFolder: "." });
    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(devId, epId, path.join("iPodRocks", "ipodrocks-server.db"));

    deleteEpisodes(db, [epId]);
    expect(fs.existsSync(victim)).toBe(true);
  });

  itDb("the same via unsubscribe", () => {
    const victim = plantVictim();
    const { subId, epId } = seedEpisode();
    const devId = addDevice({ transport: "web", mountPath: path.join(tmp, "config"), podcastFolder: "." });
    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(devId, epId, path.join("iPodRocks", "ipodrocks-server.db"));

    unsubscribe(db, subId);
    expect(fs.existsSync(victim)).toBe(true);
  });

  itDb("an attached web device gets the delete through its browser, under the synthetic root", async () => {
    const { epId } = seedEpisode();
    const devId = addDevice({ transport: "web", mountPath: "/somewhere/real", podcastFolder: "Podcasts" });
    const calls: Array<{ verb: string; args: unknown[] }> = [];
    const transport: DeviceRpcTransport = {
      clockSkewMs: 0,
      rootName: "ipod",
      writable: true,
      call: async <T,>(verb: string, args: unknown[]) => {
        calls.push({ verb, args });
        return (verb === "readdir" ? [] : undefined) as T;
      },
      pull: async () => {},
      push: async () => {},
    } as unknown as DeviceRpcTransport;
    registerDeviceTransport(devId, transport);
    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(devId, epId, path.join("Podcasts", "Show", "ep.mp3"));

    deleteEpisodes(db, [epId]);
    await vi.waitFor(() => expect(calls.some((c) => c.verb === "unlink")).toBe(true));
    const unlink = calls.find((c) => c.verb === "unlink")!;
    expect(unlink.args[0]).toBe("Podcasts/Show/ep.mp3");
    // And the row's own mount_path played no part in it.
    expect(webDeviceRoot(devId)).not.toBe("/somewhere/real");
  });

  itDb("a local device's path is contained under its podcast folder", () => {
    const mount = path.join(tmp, "ipod");
    const inside = path.join(mount, "Podcasts", "Show", "ep.mp3");
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, "episode");
    const outside = path.join(mount, "Music", "keep.mp3");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "a track");

    const { epId } = seedEpisode();
    const devId = addDevice({ transport: "local", mountPath: mount, podcastFolder: "Podcasts" });
    // A second episode row pointing out of the podcast folder.
    const ep2 = Number(
      db
        .prepare(
          `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
           SELECT subscription_id, 'g2', 't', 'u', 'ready' FROM podcast_episodes WHERE id = ?`
        )
        .run(epId).lastInsertRowid
    );
    const ins = db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    );
    ins.run(devId, epId, path.join("Podcasts", "Show", "ep.mp3"));
    ins.run(devId, ep2, path.join("Podcasts", "..", "Music", "keep.mp3"));

    deleteEpisodes(db, [epId, ep2]);
    expect(fs.existsSync(inside)).toBe(false); // the control: real cleanup still works
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("containPodcastDevicePath refuses every escape", () => {
    const m = path.resolve("/mnt/ipod");
    expect(containPodcastDevicePath(m, "Podcasts", "Podcasts/Show/a.mp3")).toBe(
      path.join(m, "Podcasts", "Show", "a.mp3")
    );
    expect(containPodcastDevicePath(m, ".", "iPodRocks/x.db")).toBeNull();
    expect(containPodcastDevicePath(m, "", "x.db")).toBeNull();
    expect(containPodcastDevicePath(m, "..", "../etc/passwd")).toBeNull();
    expect(containPodcastDevicePath(m, "Podcasts", "Podcasts/../../etc/passwd")).toBeNull();
    expect(containPodcastDevicePath(m, "Podcasts", "/etc/passwd")).toBeNull();
    expect(containPodcastDevicePath(m, "Podcasts", "Podcasts")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// device:update cannot rewrite what a web device's paths mean.
// ---------------------------------------------------------------------------
describe("updateDevice on a browser-held device", () => {
  let db: TestDb;
  let core: DevicesCore;
  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    core = new DevicesCore(db);
  });
  afterEach(() => closeDb(db));

  itDb("keeps the synthetic root whatever mountPath is sent — and repairs a rewritten one", () => {
    const dev = core.addDevice({ name: "web-ipod", transport: "web" } as never);
    const id = dev.profile.id;
    expect(dev.profile.mountPath).toBe(webDeviceRoot(id));

    core.updateDevice(id, { mountPath: "/home/svc/.config" });
    expect(core.getDeviceById(id)!.profile.mountPath).toBe(webDeviceRoot(id));

    // A row an earlier version let a guest rewrite.
    db.prepare("UPDATE devices SET mount_path = '/home/svc/.config' WHERE id = ?").run(id);
    core.updateDevice(id, { mountPath: undefined, name: "web-ipod" });
    expect(core.getDeviceById(id)!.profile.mountPath).toBe(webDeviceRoot(id));
  });

  itDb("refuses turning Auto Podcasts on for a remote device, allows turning it off", () => {
    const id = core.addDevice({ name: "web-ipod", transport: "web" } as never).profile.id;
    expect(() => core.updateDevice(id, { autoPodcastsEnabled: true })).toThrow(/Auto Podcasts/);
    expect(core.getDeviceById(id)!.profile.autoPodcastsEnabled).toBe(false);
    // Off is always allowed, even for a row that somehow has it on.
    db.prepare("UPDATE devices SET auto_podcasts_enabled = 1 WHERE id = ?").run(id);
    core.updateDevice(id, { autoPodcastsEnabled: false });
    expect(core.getDeviceById(id)!.profile.autoPodcastsEnabled).toBe(false);
  });

  itDb("the control: a local device may still turn Auto Podcasts on and move its mount", () => {
    const tmp = createTmpDir("dev-local-");
    try {
      const id = core.addDevice({ name: "local-ipod", mountPath: tmp } as never).profile.id;
      core.updateDevice(id, { autoPodcastsEnabled: true });
      expect(core.getDeviceById(id)!.profile.autoPodcastsEnabled).toBe(true);
      const moved = path.join(tmp, "elsewhere");
      core.updateDevice(id, { mountPath: moved });
      expect(core.getDeviceById(id)!.profile.mountPath).toBe(path.resolve(moved));
    } finally {
      cleanupTmp(tmp);
    }
  });

  itDb("content folders must name a folder strictly inside the device", () => {
    const id = core.addDevice({ name: "web-ipod", transport: "web" } as never).profile.id;
    for (const bad of ["", "   ", ".", "./", "..", "../x", "a/../..", "/etc", "C:\\Windows", "\\\\srv\\share", 5, null]) {
      expect(() => core.updateDevice(id, { podcastFolder: bad }), String(bad)).toThrow();
    }
    expect(core.getDeviceById(id)!.profile.podcastFolder).toBe("Podcasts");
    core.updateDevice(id, { podcastFolder: "iPod_Control/Podcasts", musicFolder: " Music " });
    const p = core.getDeviceById(id)!.profile;
    expect(p.podcastFolder).toBe("iPod_Control/Podcasts");
    expect(p.musicFolder).toBe("Music");
  });

  itDb("addDevice applies the same folder rule", () => {
    expect(() =>
      core.addDevice({ name: "bad", transport: "web", podcastFolder: ".." } as never)
    ).toThrow();
  });

  it("sanitizeContentFolder accepts nested relative paths either separator", () => {
    expect(sanitizeContentFolder("iPod_Control\\Music")).toBe("iPod_Control\\Music");
    expect(sanitizeContentFolder("Music/Albums")).toBe("Music/Albums");
  });
});

// ---------------------------------------------------------------------------
// One subscription cannot stop the others, and runs do not stack.
// ---------------------------------------------------------------------------
describe("refreshAll isolates subscriptions and coalesces overlapping runs", () => {
  let db: TestDb;
  beforeEach(() => {
    vi.mocked(fetchAndParseFeed).mockReset();
    if (canRunDbTests) db = createTestDb();
  });
  afterEach(() => closeDb(db));

  function addRss(feedId: number, url: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO podcast_subscriptions (feed_id, title, feed_url, source, auto_count, created_at)
           VALUES (?, ?, ?, 'rss', 1, datetime('now', ?))`
        )
        .run(feedId, url, url, `+${feedId * -1} seconds`).lastInsertRowid
    );
  }

  itDb("a subscription whose refresh throws does not stop the ones after it", async () => {
    addRss(-1, "https://hostile/feed");
    const good = addRss(-2, "https://good/feed");
    // The hostile feed's refresh rejects *past* refreshRssSubscription's own
    // catch — a throwing download does exactly that.
    const { downloadEpisode } = await import("../../main/podcasts/podcast-downloader");
    vi.mocked(fetchAndParseFeed).mockImplementation(async (url: string) => ({
      title: url,
      author: null,
      description: null,
      imageUrl: null,
      feedUrl: url,
      episodes: [
        {
          guid: `${url}#1`,
          title: "e",
          description: "",
          enclosureUrl: `${url}/e.mp3`,
          enclosureLength: 1,
          durationSeconds: 1,
          publishedAt: 1_700_000_000,
        },
      ],
    }) as never);
    vi.mocked(downloadEpisode).mockImplementation(async (_db, epId) => {
      const sub = db
        .prepare("SELECT s.feed_url FROM podcast_episodes e JOIN podcast_subscriptions s ON s.id = e.subscription_id WHERE e.id = ?")
        .get(epId) as { feed_url: string };
      if (sub.feed_url.includes("hostile")) throw new Error("enclosure timed out");
      return { localPath: "/dev/null" };
    });

    await refreshAll(db, "", "");
    const row = db.prepare("SELECT last_refreshed_at FROM podcast_subscriptions WHERE id = ?").get(good) as {
      last_refreshed_at: string | null;
    };
    expect(row.last_refreshed_at).not.toBeNull();
    expect(vi.mocked(downloadEpisode).mock.calls.length).toBe(2);
  });

  itDb("ten overlapping calls cost at most two passes", async () => {
    addRss(-1, "https://a/feed");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(fetchAndParseFeed).mockImplementation(async () => {
      await gate;
      throw new Error("unreachable feed"); // caught by refreshRssSubscription
    });

    const calls = Array.from({ length: 10 }, () => refreshAll(db, "", ""));
    // Everyone shares the in-flight pass rather than starting their own.
    expect(vi.mocked(fetchAndParseFeed).mock.calls.length).toBe(1);
    release();
    await Promise.all(calls);
    // One pass, plus exactly one re-run for everything that arrived mid-pass.
    expect(vi.mocked(fetchAndParseFeed).mock.calls.length).toBe(2);
  });
});
