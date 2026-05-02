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

vi.mock("../main/podcasts/podcast-refresh", () => ({
  getReadyTargetEpisodes: vi.fn(),
}));

vi.mock("../main/sync/sync-executor", () => ({
  copyFileToDevice: vi.fn(),
}));

import { getReadyTargetEpisodes } from "../main/podcasts/podcast-refresh";
import { copyFileToDevice } from "../main/sync/sync-executor";

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
});

afterEach(() => {
  if (db) db.close();
  if (tmpMount) fs.rmSync(tmpMount, { recursive: true, force: true });
  if (tmpSrc) fs.rmSync(tmpSrc, { recursive: true, force: true });
});

function insertDevice(opts: { autoPodcasts: boolean }): number {
  const modeRow = db.prepare("SELECT id FROM device_transfer_modes WHERE name='copy'").get() as { id: number };
  const result = db.prepare([
    "INSERT INTO devices",
    "(name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder,",
    " default_transfer_mode_id, auto_podcasts_enabled)",
    "VALUES (?, ?, 'Music', 'Podcasts', 'Audiobooks', 'Playlists', ?, ?)",
  ].join(" ")).run("TestDevice", tmpMount, modeRow.id, opts.autoPodcasts ? 1 : 0);
  return Number(result.lastInsertRowid);
}

describe("syncPodcastsToDevice", () => {
  it.skipIf(!canRunDbTests)("copies ready episodes and records in device_podcast_synced", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);

    const srcFile = path.join(tmpSrc, "ep1.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(100));

    vi.mocked(getReadyTargetEpisodes).mockReturnValue([
      { id: 1, feedId: 7, localPath: srcFile },
    ]);

    vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcFile, dest);
      return true;
    });

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(0);

    const row = db
      .prepare("SELECT device_relative_path FROM device_podcast_synced WHERE device_id = ? AND episode_id = 1")
      .get(deviceId) as { device_relative_path: string } | undefined;
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
    vi.mocked(getReadyTargetEpisodes).mockReturnValue([
      { id: 1, feedId: 7, localPath: "/fake/ep.mp3" },
    ]);

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(0);
    expect(copyFileToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("skips already-synced episodes", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);

    vi.mocked(getReadyTargetEpisodes).mockReturnValue([
      { id: 2, feedId: 7, localPath: "/fake/ep2.mp3" },
    ]);

    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, 2, ?)"
    ).run(deviceId, "Podcasts/show/ep2.mp3");

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(0);
    expect(copyFileToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)(
    "copies episodes when called during manual sync (autoPodcastsEnabled = true)",
    async () => {
      // Regression: syncPodcastsToDevice was never called during sync:start,
      // so devices with autoPodcastsEnabled would never receive subscription episodes.
      const deviceId = insertDevice({ autoPodcasts: true });
      subscribe(db, testFeed);

      const srcFile = path.join(tmpSrc, "ep_manual.mp3");
      fs.writeFileSync(srcFile, Buffer.alloc(200));

      vi.mocked(getReadyTargetEpisodes).mockReturnValue([
        { id: 10, feedId: 7, localPath: srcFile },
      ]);
      vi.mocked(copyFileToDevice).mockImplementation(async (_src, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(srcFile, dest);
        return true;
      });

      // Simulate what sync:start now does: call syncPodcastsToDevice for auto-podcast devices
      const result = await syncPodcastsToDevice(db, deviceId);

      expect(result.synced).toBe(1);
      expect(result.errors).toBe(0);
      expect(copyFileToDevice).toHaveBeenCalledWith(srcFile, expect.stringContaining("Podcasts"));

      const row = db
        .prepare("SELECT 1 FROM device_podcast_synced WHERE device_id = ? AND episode_id = 10")
        .get(deviceId);
      expect(row).toBeDefined();
    }
  );

  it.skipIf(!canRunDbTests)("emits total_add and copy progress events when episodes are found", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);

    const srcFile = path.join(tmpSrc, "ep_progress.mp3");
    fs.writeFileSync(srcFile, Buffer.alloc(50));

    vi.mocked(getReadyTargetEpisodes).mockReturnValue([
      { id: 20, feedId: 7, localPath: srcFile },
    ]);
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

  it.skipIf(!canRunDbTests)("emits log message when no subscriptions are configured", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });

    const events: unknown[] = [];
    await syncPodcastsToDevice(db, deviceId, (e) => events.push(e));

    const logEvent = events.find((e: any) => e.event === "log") as any;
    expect(logEvent).toBeDefined();
    expect(logEvent.message).toMatch(/no subscriptions/i);
  });

  it.skipIf(!canRunDbTests)("emits log message when all episodes are already synced", async () => {
    const deviceId = insertDevice({ autoPodcasts: true });
    subscribe(db, testFeed);

    vi.mocked(getReadyTargetEpisodes).mockReturnValue([
      { id: 30, feedId: 7, localPath: "/fake/ep30.mp3" },
    ]);
    db.prepare(
      "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, 30, ?)"
    ).run(deviceId, "Podcasts/Dev Podcast/30.mp3");

    const events: unknown[] = [];
    await syncPodcastsToDevice(db, deviceId, (e) => events.push(e));

    const logEvent = events.find((e: any) => e.event === "log") as any;
    expect(logEvent).toBeDefined();
    expect(logEvent.message).toMatch(/already synced/i);
  });
});
