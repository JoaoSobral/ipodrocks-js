/**
 * @vitest-environment node
 *
 * Behavioral coverage for the Genius playlist engine — the DB-backed
 * generators that read Rockbox `playback.log` data out of `playback_logs`.
 *
 * Focuses on the time-window generators (which had bugs / timezone hazards)
 * and the availability gating surfaced to the UI. Drives the engine functions
 * in `src/main/playlists/genius-engine.ts` directly against an in-memory DB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

import {
  generateGeniusPlaylistFromDb,
  getGeniusTypesWithAvailability,
} from "../../main/playlists/genius-engine";

const itDb = it.skipIf(!canRunDbTests);

const MONTH_SEC = 30 * 24 * 60 * 60;

/** Insert a matched playback-log row for a track. */
function seedPlay(
  db: TestDb,
  trackId: number,
  tsSec: number,
  opts: { elapsedMs?: number; totalMs?: number } = {}
): void {
  const elapsedMs = opts.elapsedMs ?? 200_000;
  const totalMs = opts.totalMs ?? 200_000;
  const ratio = totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0;
  db.prepare(
    `INSERT INTO playback_logs
       (device_id, device_db_id, device_name, timestamp_tick, elapsed_ms,
        total_ms, file_path, matched_track_id, completion_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "dev1",
    1,
    "Test Device",
    tsSec,
    elapsedMs,
    totalMs,
    `/music/track-${trackId}-${tsSec}.flac`,
    trackId,
    ratio
  );
}

describe("Genius engine — time-window generators", () => {
  let db: TestDb;
  let folderId: number;
  const nowSec = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("nostalgia returns tracks first played 12–36 months ago (regression)", () => {
    // In range: first played 24 months ago.
    const inRange = seedTrack(db, { path: "/music/nostalgic.flac", title: "Nostalgic", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, inRange, nowSec - 24 * MONTH_SEC);
    // Too recent: 6 months ago.
    const recent = seedTrack(db, { path: "/music/recent.flac", title: "Recent", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, recent, nowSec - 6 * MONTH_SEC);
    // Too old: 40 months ago.
    const old = seedTrack(db, { path: "/music/old.flac", title: "Old", artist: "C", album: "Z", libraryFolderId: folderId });
    seedPlay(db, old, nowSec - 40 * MONTH_SEC);

    const result = generateGeniusPlaylistFromDb("nostalgia", db);
    const titles = result.tracks.map((t) => t.title);
    expect(titles).toEqual(["Nostalgic"]);
  });

  itDb("oldies returns only tracks first played 36+ months ago", () => {
    const old = seedTrack(db, { path: "/music/o1.flac", title: "Ancient", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, old, nowSec - 40 * MONTH_SEC);
    const midish = seedTrack(db, { path: "/music/o2.flac", title: "Newer", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, midish, nowSec - 24 * MONTH_SEC);

    const result = generateGeniusPlaylistFromDb("oldies", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Ancient"]);
  });

  itDb("late_night buckets by device-local (UTC-decoded) hour", () => {
    // 23:30 — within the 22:00–05:00 window regardless of the runner's TZ.
    const night = seedTrack(db, { path: "/music/n.flac", title: "Night", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, night, Math.floor(Date.UTC(2025, 0, 15, 23, 30, 0) / 1000), { elapsedMs: 190_000, totalMs: 200_000 });
    // 14:00 — daytime, excluded.
    const day = seedTrack(db, { path: "/music/d.flac", title: "Day", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, day, Math.floor(Date.UTC(2025, 0, 15, 14, 0, 0) / 1000), { elapsedMs: 190_000, totalMs: 200_000 });

    const result = generateGeniusPlaylistFromDb("late_night", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Night"]);
  });

  itDb("time_capsule matches the target month using UTC boundaries", () => {
    const inMonth = seedTrack(db, { path: "/music/m.flac", title: "MayTrack", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, inMonth, Math.floor(Date.UTC(2024, 4, 10, 12, 0, 0) / 1000)); // May 2024
    const other = seedTrack(db, { path: "/music/j.flac", title: "JuneTrack", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, other, Math.floor(Date.UTC(2024, 5, 10, 12, 0, 0) / 1000)); // June 2024

    const result = generateGeniusPlaylistFromDb("time_capsule", db, { targetMonth: 5, targetYear: 2024 });
    expect(result.tracks.map((t) => t.title)).toEqual(["MayTrack"]);
  });

  itDb("empty generators explain the data constraint via criteria", () => {
    const t = seedTrack(db, { path: "/music/x.flac", title: "X", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, t, nowSec - 2 * MONTH_SEC); // recent play; not an "oldie"

    const result = generateGeniusPlaylistFromDb("oldies", db);
    expect(result.tracks).toHaveLength(0);
    expect(result.criteria).toMatch(/36\+ months/);
  });
});

describe("Genius engine — availability gating", () => {
  let db: TestDb;
  let folderId: number;
  const nowSec = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("with no playback data, all 14 types are returned but time-gated ones are unavailable", () => {
    const res = getGeniusTypesWithAvailability(db);
    expect(res.types).toHaveLength(14);
    expect(res.dataMonths).toBe(0);
    expect(res.firstLogDate).toBeNull();

    const byValue = new Map(res.types.map((t) => [t.value, t]));
    expect(byValue.get("most_played")?.available).toBe(true);
    expect(byValue.get("oldies")?.available).toBe(false);
    expect(byValue.get("nostalgia")?.available).toBe(false);
    expect(byValue.get("time_capsule")?.available).toBe(false);
  });

  itDb("with 40 months of history, every type becomes available", () => {
    const t = seedTrack(db, { path: "/music/x.flac", title: "X", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, t, nowSec - 40 * MONTH_SEC);

    const res = getGeniusTypesWithAvailability(db);
    expect(res.dataMonths).toBeGreaterThanOrEqual(36);
    expect(res.firstLogDate).not.toBeNull();
    expect(res.types.every((t2) => t2.available === true)).toBe(true);
  });
});
