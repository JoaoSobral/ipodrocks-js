/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

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
import {
  subscribe,
  unsubscribe,
  deleteEpisodes,
} from "../main/podcasts/podcast-subscriptions";
import type { PodcastSearchResult } from "../shared/types";

let db: import("better-sqlite3").Database;
let tmpMount: string;
let tmpSrc: string;

const testFeed: PodcastSearchResult = {
  feedId: 99,
  title: "Test Podcast",
  author: "Tester",
  description: "",
  imageUrl: "",
  feedUrl: "https://example.com/feed.xml",
  episodeCount: 3,
};

beforeEach(() => {
  if (canRunDbTests) {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO device_transfer_modes (name) VALUES (?)").run("copy");
  }
  tmpMount = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-sub-mount-"));
  tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-sub-src-"));
});

afterEach(() => {
  if (db) db.close();
  if (tmpMount) fs.rmSync(tmpMount, { recursive: true, force: true });
  if (tmpSrc) fs.rmSync(tmpSrc, { recursive: true, force: true });
});

function insertDevice(): number {
  const modeRow = db.prepare("SELECT id FROM device_transfer_modes WHERE name='copy'").get() as { id: number };
  const result = db.prepare(
    "INSERT INTO devices (name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder, default_transfer_mode_id, auto_podcasts_enabled) VALUES (?, ?, 'Music', 'Podcasts', 'Audiobooks', 'Playlists', ?, 1)"
  ).run("Device", tmpMount, modeRow.id);
  return Number(result.lastInsertRowid);
}

function insertEpisode(subId: number, localPath: string | null): number {
  const result = db.prepare(
    `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state, local_path)
     VALUES (?, ?, 'Ep Title', 'https://example.com/ep.mp3', ?, ?)`
  ).run(subId, `guid-${Math.random()}`, localPath ? "ready" : "pending", localPath);
  return Number(result.lastInsertRowid);
}

function recordSynced(deviceId: number, epId: number, relPath: string): void {
  db.prepare(
    "INSERT INTO device_podcast_synced (device_id, episode_id, device_relative_path) VALUES (?, ?, ?)"
  ).run(deviceId, epId, relPath);
}

describe("deleteEpisodes", () => {
  it.skipIf(!canRunDbTests)("marks episodes as skipped and clears local_path", () => {
    subscribe(db, testFeed);
    const subId = (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;

    const localFile = path.join(tmpSrc, "ep.mp3");
    fs.writeFileSync(localFile, Buffer.alloc(10));
    const epId = insertEpisode(subId, localFile);

    deleteEpisodes(db, [epId]);

    const row = db.prepare("SELECT download_state, local_path FROM podcast_episodes WHERE id = ?").get(epId) as { download_state: string; local_path: string | null };
    expect(row.download_state).toBe("skipped");
    expect(row.local_path).toBeNull();
  });

  it.skipIf(!canRunDbTests)("deletes the local file from disk", () => {
    subscribe(db, testFeed);
    const subId = (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;

    const localFile = path.join(tmpSrc, "ep2.mp3");
    fs.writeFileSync(localFile, Buffer.alloc(10));
    const epId = insertEpisode(subId, localFile);

    expect(fs.existsSync(localFile)).toBe(true);
    deleteEpisodes(db, [epId]);
    expect(fs.existsSync(localFile)).toBe(false);
  });

  it.skipIf(!canRunDbTests)("deletes the file from synced devices and removes the sync record", () => {
    subscribe(db, testFeed);
    const subId = (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;
    const deviceId = insertDevice();

    const epId = insertEpisode(subId, path.join(tmpSrc, "ep3.mp3"));
    const relPath = path.join("Podcasts", "Test Podcast", "ep3.mp3");
    const deviceFile = path.join(tmpMount, relPath);
    fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
    fs.writeFileSync(deviceFile, Buffer.alloc(10));
    recordSynced(deviceId, epId, relPath);

    deleteEpisodes(db, [epId]);

    expect(fs.existsSync(deviceFile)).toBe(false);
    const syncRow = db.prepare("SELECT 1 FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?").get(deviceId, epId);
    expect(syncRow).toBeUndefined();
  });

  it.skipIf(!canRunDbTests)("no-ops gracefully when episodeIds is empty", () => {
    expect(() => deleteEpisodes(db, [])).not.toThrow();
  });
});

describe("unsubscribe with cleanup", () => {
  it.skipIf(!canRunDbTests)("deletes local episode files before removing the subscription", () => {
    subscribe(db, testFeed);
    const subId = (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;

    const localFile = path.join(tmpSrc, "ep_unsub.mp3");
    fs.writeFileSync(localFile, Buffer.alloc(10));
    insertEpisode(subId, localFile);

    expect(fs.existsSync(localFile)).toBe(true);
    unsubscribe(db, subId);
    expect(fs.existsSync(localFile)).toBe(false);

    const subRow = db.prepare("SELECT 1 FROM podcast_subscriptions WHERE id = ?").get(subId);
    expect(subRow).toBeUndefined();
  });

  it.skipIf(!canRunDbTests)("deletes device files before removing the subscription", () => {
    subscribe(db, testFeed);
    const subId = (db.prepare("SELECT id FROM podcast_subscriptions LIMIT 1").get() as { id: number }).id;
    const deviceId = insertDevice();

    const epId = insertEpisode(subId, null);
    const relPath = path.join("Podcasts", "Test Podcast", "ep_device.mp3");
    const deviceFile = path.join(tmpMount, relPath);
    fs.mkdirSync(path.dirname(deviceFile), { recursive: true });
    fs.writeFileSync(deviceFile, Buffer.alloc(10));
    recordSynced(deviceId, epId, relPath);

    unsubscribe(db, subId);

    expect(fs.existsSync(deviceFile)).toBe(false);
    const subRow = db.prepare("SELECT 1 FROM podcast_subscriptions WHERE id = ?").get(subId);
    expect(subRow).toBeUndefined();
  });
});
