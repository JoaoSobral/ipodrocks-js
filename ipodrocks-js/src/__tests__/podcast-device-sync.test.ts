/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let canRunDbTests = false;
try {
  const probe = require("better-sqlite3");
  const d = new probe(":memory:");
  d.close();
  canRunDbTests = true;
} catch { /* better-sqlite3 compiled for Electron; skip */ }
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SCHEMA_SQL } from "../main/database/schema";
import { subscribe } from "../main/podcasts/podcast-subscriptions";
import { syncPodcastsToDevice } from "../main/podcasts/podcast-device-sync";
import type { PodcastSearchResult } from "../shared/types";

vi.mock("../main/sync/sync-executor", () => ({
  copyFileToDevice: vi.fn(),
}));

// The real check requires a mounted-volume `dev` mismatch which a tmpdir does
// not provide; force it to true so the sync logic itself is what's tested.
vi.mock("../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

import { copyFileToDevice } from "../main/sync/sync-executor";
import { isDeviceMountPathOnline } from "../main/devices/device-online";

let db: import("better-sqlite3").Database;
let tmpMount: string;
let tmpSrc: string;

const testFeed: PodcastSearchResult = {
  feedId: 7,
  title: "Dev Podcast",
  author: "Dev",
  description: "",
  imageUrl: "",
  feedUrl: "https://example.com/feed.xml",
  episodeCount: 5,
};

beforeEach(() => {
  if (canRunDbTests) {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO device_transfer_modes (name) VALUES (?)").run("copy");
  }

  tmpMount = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-device-"));
  tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-src-"));
  vi.clearAllMocks();
  vi.mocked(isDeviceMountPathOnline).mockReturnValue(true);
});

afterEach(() => {
  if (db) db.close();
  if (tmpMount) fs.rmSync(tmpMount, { recursive: true, force: true });
  if (tmpSrc) fs.rmSync(tmpSrc, { recursive: true, force: true });
});

function insertDevice(opts: { autoPodcasts: boolean; devMode?: boolean }): number {
  const modeRow = db.prepare("SELECT id FROM device_transfer_modes WHERE name='copy'").get() as { id: number };
  const result = db.prepare([
    "INSERT INTO devices",
    "(name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder,",
    " default_transfer_mode_id, auto_podcasts_enabled, dev_mode)",
    "VALUES (?, ?, 'Music', 'Podcasts', 'Audiobooks', 'Playlists', ?, ?, ?)",
  ].join(" ")).run("TestDevice", tmpMount, modeRow.id, opts.autoPodcasts ? 1 : 0, opts.devMode ? 1 : 0);
  return Number(result.lastInsertRowid);
}

function insertEpisode(subId: number, opts: { localPath: string | null; downloadState?: string; title?: string }): number {
  const result = db.prepare(
    `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state, local_path)
     VALUES (?, ?, ?, 'https://example.com/ep.mp3', ?, ?)`
  ).run(subId, `guid-${Math.random()}`, opts.title ?? "Test Episode", opts.downloadState ?? "ready", opts.localPath);
  return Number(result.lastInsertRowid);
}

function getSubId(): number {
  return (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;
}

describe("syncPodcastsToDevice", () => {
  it.skipIf(!canRunDbTests)("copies ready episodes and records in device_podcast_synced", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();

    const srcFile = path.join(tmpSrc, "ep1.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(100));
    const epId = insertEpisode(subId, { localPath: srcFile });

    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(0);

    const row = db
      .prepare("SELECT device_relative_path FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?")
      .get(deviceId, epId) as { device_relative_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.device_relative_path).toContain("Podcasts");

    // Library tables must be untouched
    const libCount = db.prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number };
    expect(libCount.n).toBe(0);
    const syncedCount = db.prepare("SELECT COUNT(*) as n FROM device_synced_tracks").get() as { n: number };
    expect(syncedCount.n).toBe(0);
  });

  it.skipIf(!canRunDbTests)("skips sync when auto_podcasts_enabled = 0", async () => {
    const deviceId = insertDevice({ autoPodcasts: false });
    subscribe(db, testFeed);
    const subId = getSubId();
    insertEpisode(subId, { localPath: "/fake/ep.mp3" });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(0);
    expect(copyFileToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("skips already-synced episodes when file exists on device", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();
    const epId = insertEpisode(subId, { localPath: "/fake/ep2.mp3" });

    const relPath = path.join("Podcasts", "Dev Podcast", "ep2.mp3");
    const deviceFilePath = path.join(tmpMount, relPath);
    fs.mkdirSync(path.dirname(deviceFilePath), { recursive: true });
    fs.writeFileSync(deviceFilePath, Buffer.alloc(10));

    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(deviceId, epId, relPath);

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(0);
    expect(copyFileToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("re-copies episodes whose device_podcast_synced record is stale (file missing from device)", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();

    const srcFile = path.join(tmpSrc, "ep_stale.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(100));
    const epId = insertEpisode(subId, { localPath: srcFile });

    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(deviceId, epId, path.join("Podcasts", "Dev Podcast", "missing.mp3"));

    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(1);
    expect(copyFileToDevice).toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("mirrors all ready episodes regardless of auto_count", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 1 WHERE id = ?").run(subId);

    const src1 = path.join(tmpSrc, "ep_a.mp3");
    const src2 = path.join(tmpSrc, "ep_b.mp3");
    fs.writeFileSync(src1, Buffer.alloc(50));
    fs.writeFileSync(src2, Buffer.alloc(50));
    insertEpisode(subId, { localPath: src1 });
    insertEpisode(subId, { localPath: src2 });

    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(_src, dest);
      return true;
    });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(2);
    expect(result.errors).toBe(0);
  });

  it.skipIf(!canRunDbTests)(
    "copies episodes when called during manual sync (autoPodcastsEnabled = true)",
    async () => {
      const deviceId = insertDevice({ autoPodcasts: true });
      subscribe(db, testFeed);
      const subId = getSubId();

      const srcFile = path.join(tmpSrc, "ep_manual.mp3");
      fs.writeFileSync(srcFile, Buffer.alloc(200));
      const epId = insertEpisode(subId, { localPath: srcFile });

      vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(srcFile, dest);
        return true;
      });

      const result = await syncPodcastsToDevice(db, deviceId);

      expect(result.synced).toBe(1);
      expect(result.errors).toBe(0);
      expect(copyFileToDevice).toHaveBeenCalledWith(srcFile, expect.stringContaining("Podcasts"));

      const row = db
        .prepare("SELECT 1 FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?")
        .get(deviceId, epId);
      expect(row).toBeDefined();
    }
  );

  it.skipIf(!canRunDbTests)("emits total_add and copy progress events when episodes are found", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();

    const srcFile = path.join(tmpSrc, "ep_progress.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(50));
    insertEpisode(subId, { localPath: srcFile });

    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    const events: unknown[] = [];
    await syncPodcastsToDevice(db, deviceId, (e) => events.push(e));

    const totalAdd = events.find((e: any) => e.event === "total_add") as any;
    expect(totalAdd).toBeDefined();
    expect(totalAdd.path).toBe("1");

    const copyEvent = events.find((e: any) => e.event === "copy") as any;
    expect(copyEvent).toBeDefined();
    expect(copyEvent.status).toBe("copied");
    expect(copyEvent.contentType).toBe("podcast");
  });

  it.skipIf(!canRunDbTests)("uses episode title as the destination filename", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();

    const srcFile = path.join(tmpSrc, "episode_titled.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(100));
    insertEpisode(subId, { localPath: srcFile, title: "My Great Episode" });

    const capturedDest: string[] = [];
    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      capturedDest.push(dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    await syncPodcastsToDevice(db, deviceId);

    expect(capturedDest).toHaveLength(1);
    expect(path.basename(capturedDest[0])).toBe("My Great Episode.mp3");
  });

  it.skipIf(!canRunDbTests)("emits log message when no subscriptions are configured", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });

    const events: unknown[] = [];
    await syncPodcastsToDevice(db, deviceId, (e) => events.push(e));

    const logEvent = events.find((e: any) => e.event === "log") as any;
    expect(logEvent).toBeDefined();
    expect(logEvent.message).toMatch(/no subscriptions/i);
  });

  it.skipIf(!canRunDbTests)("returns 0/0 when the device mount path is not actually online", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();
    insertEpisode(subId, { localPath: "/fake/ep99.mp3" });
    vi.mocked(isDeviceMountPathOnline).mockReturnValue(false);

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result).toEqual({ synced: 0, errors: 0 });
    expect(copyFileToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("syncs to a dev mode device even when isDeviceMountPathOnline returns false", async () => {
    const deviceId = insertDevice({ autoPodcasts: true, devMode: true });
    subscribe(db, testFeed);
    const subId = getSubId();

    const srcFile = path.join(tmpSrc, "ep_dev.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(50));
    insertEpisode(subId, { localPath: srcFile });

    vi.mocked(isDeviceMountPathOnline).mockReturnValue(false);
    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(0);
    expect(copyFileToDevice).toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("emits log message when all episodes are already synced", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);
    const subId = getSubId();
    const epId = insertEpisode(subId, { localPath: "/fake/ep30.mp3" });

    const relPath = path.join("Podcasts", "Dev Podcast", "30.mp3");
    const deviceFilePath = path.join(tmpMount, relPath);
    fs.mkdirSync(path.dirname(deviceFilePath), { recursive: true });
    fs.writeFileSync(deviceFilePath, Buffer.alloc(10));

    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
    ).run(deviceId, epId, relPath);

    const events: unknown[] = [];
    await syncPodcastsToDevice(db, deviceId, (e) => events.push(e));

    const logEvent = events.find((e: any) => e.event === "log") as any;
    expect(logEvent).toBeDefined();
    expect(logEvent.message).toMatch(/already synced/i);
  });
});
