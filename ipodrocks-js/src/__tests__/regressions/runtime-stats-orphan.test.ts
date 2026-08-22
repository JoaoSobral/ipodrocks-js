/**
 * @vitest-environment node
 *
 * Regression: rows keyed on tracks(id) surviving the track they belong to.
 *
 * `LibraryScanner.deleteRemovedTracks()` runs its deletes with
 * `PRAGMA foreign_keys = OFF`, so no `ON DELETE CASCADE` declared in the schema
 * ever fires there — every dependent table has to be deleted by hand. That has
 * already caused three shipped bugs (orphaned codec configurations, playlists
 * holding deleted songs, shadow transcodes accumulating).
 *
 * This covers the two new runtime-data tables and, in the same pass, the three
 * rating tables that were already being orphaned: `device_track_ratings`,
 * `rating_conflicts` and `rating_events` all declare a cascade that has never
 * had any effect in this code path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedDevice,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

import { LibraryScanner } from "../../main/library/library-scanner";
import { LibraryCore } from "../../main/library/library-core";

const itDb = it.skipIf(!canRunDbTests);

/** Tables that must never outlive the track they point at. */
const TRACK_TABLES = [
  ["device_runtime_stats", "track_id"],
  ["runtime_play_deltas", "track_id"],
  ["device_track_ratings", "track_id"],
  ["rating_conflicts", "track_id"],
  ["rating_events", "track_id"],
  ["playback_stats", "track_id"],
  ["playback_logs", "matched_track_id"],
] as const;

describe("dependent rows are removed with their track", () => {
  let db: TestDb;
  let folderId: number;
  let deviceId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt/ipod" });
  });

  afterEach(() => {
    closeDb(db);
  });

  function seedSong(n: number): number {
    return seedTrack(db, {
      path: `/music/song-${n}.flac`,
      title: `Song ${n}`,
      artist: "Artist",
      album: "Album",
      libraryFolderId: folderId,
    });
  }

  /** Give the track a row in every table keyed on tracks(id). */
  function seedDependents(trackId: number): void {
    db.prepare(
      `INSERT INTO device_runtime_stats
         (device_id, track_id, device_path, play_count, play_time_ms, rating)
       VALUES (?, ?, ?, 4, 800000, 8)`
    ).run(deviceId, trackId, `music/song-${trackId}.flac`);
    db.prepare(
      `INSERT INTO runtime_play_deltas
         (device_id, track_id, observed_at, plays_delta, playtime_delta_ms)
       VALUES (?, ?, CURRENT_TIMESTAMP, 2, 400000)`
    ).run(deviceId, trackId);
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating)
       VALUES (?, ?, 8)`
    ).run(deviceId, trackId);
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating)
       VALUES (?, ?, 8, 6)`
    ).run(trackId, deviceId);
    db.prepare(
      `INSERT INTO rating_events (track_id, device_id, new_rating, source)
       VALUES (?, ?, 8, 'device_ingest')`
    ).run(trackId, deviceId);
    db.prepare(
      `INSERT INTO playback_stats (track_id, total_plays) VALUES (?, 4)`
    ).run(trackId);
    db.prepare(
      `INSERT INTO playback_logs
         (device_id, device_db_id, timestamp_tick, elapsed_ms, total_ms, file_path, matched_track_id)
       VALUES (?, ?, 1700000000, 200000, 200000, ?, ?)`
    ).run(String(deviceId), deviceId, `/Music/song-${trackId}.flac`, trackId);
  }

  function orphanCount(trackId: number): number {
    let total = 0;
    for (const [table, column] of TRACK_TABLES) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(trackId) as { n: number };
      total += row.n;
    }
    return total;
  }

  itDb("the scanner's foreign-keys-off delete takes them all", () => {
    const trackId = seedSong(1);
    seedDependents(trackId);
    expect(orphanCount(trackId)).toBe(TRACK_TABLES.length);

    // deleteRemovedTracks is private; this test exists precisely to pin its
    // foreign-keys-off behaviour, so reach it directly rather than driving a
    // whole folder scan to get at it.
    const scanner = new LibraryScanner(db) as unknown as {
      deleteRemovedTracks(paths: string[]): unknown;
    };
    scanner.deleteRemovedTracks(["/music/song-1.flac"]);

    expect(orphanCount(trackId)).toBe(0);
  });

  itDb("deleting a single track takes them all", () => {
    const trackId = seedSong(2);
    seedDependents(trackId);

    new LibraryCore(db).deleteTrack("/music/song-2.flac");

    expect(orphanCount(trackId)).toBe(0);
  });

  itDb("removing a library folder takes them all", () => {
    const a = seedSong(3);
    const b = seedSong(4);
    seedDependents(a);
    seedDependents(b);

    new LibraryCore(db).removeLibraryFolder(folderId, true);

    expect(orphanCount(a)).toBe(0);
    expect(orphanCount(b)).toBe(0);
  });

  itDb("deleting the device takes its runtime counters with it", () => {
    const trackId = seedSong(5);
    seedDependents(trackId);

    db.prepare("DELETE FROM device_runtime_stats WHERE device_id = ?").run(deviceId);
    db.prepare("DELETE FROM runtime_play_deltas WHERE device_id = ?").run(deviceId);

    const runtime = db
      .prepare("SELECT COUNT(*) AS n FROM device_runtime_stats WHERE track_id = ?")
      .get(trackId) as { n: number };
    expect(runtime.n).toBe(0);
  });
});
