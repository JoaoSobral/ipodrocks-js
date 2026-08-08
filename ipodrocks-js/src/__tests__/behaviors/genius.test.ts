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
  getAvailableGeniusTypes,
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

/**
 * Rebuild `playback_stats` from `playback_logs`, mirroring the aggregation in
 * `playback-log-ingest.ts`. Needed by anything that reads play counts, which
 * come from `playback_stats.total_plays` — never from `tracks.play_count`.
 */
function aggregateStats(db: TestDb): void {
  db.prepare(
    `INSERT OR REPLACE INTO playback_stats
       (track_id, total_plays, total_playtime_ms, avg_completion_rate,
        last_played_at, first_played_at, updated_at)
     SELECT matched_track_id, COUNT(*), SUM(elapsed_ms), AVG(completion_rate),
            datetime(MAX(timestamp_tick), 'unixepoch'),
            datetime(MIN(timestamp_tick), 'unixepoch'),
            CURRENT_TIMESTAMP
     FROM playback_logs
     WHERE matched_track_id IS NOT NULL
     GROUP BY matched_track_id`
  ).run();
}

/** A timestamp from an unset Rockbox RTC, which reports the year 2000. */
const UNSET_CLOCK_TS = Math.floor(Date.UTC(2000, 9, 10, 3, 30, 0) / 1000);

describe("Genius engine — device clock plausibility", () => {
  let db: TestDb;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("treats year-2000 timestamps as an unset clock and gates late_night", () => {
    for (let i = 0; i < 30; i++) {
      const t = seedTrack(db, { path: `/music/u${i}.flac`, title: `U${i}`, artist: "A", album: "X", libraryFolderId: folderId });
      seedPlay(db, t, UNSET_CLOCK_TS + i * 300);
    }

    const res = getGeniusTypesWithAvailability(db);
    expect(res.clockValid).toBe(false);
    expect(res.implausibleCount).toBe(30);
    expect(res.plausibleCount).toBe(0);
    // Real plays exist, so callers must not be told the history is empty.
    expect(res.totalMatched).toBe(30);
    // No trustworthy span, so no month count is claimed.
    expect(res.dataMonths).toBe(0);
    expect(res.firstLogDate).toBeNull();

    const lateNight = res.types.find((t) => t.value === "late_night");
    expect(lateNight?.available).toBe(false);
    expect(lateNight?.unavailableReason).toMatch(/clock/i);
  });

  itDb("accepts a correctly-set clock once enough plausible rows exist", () => {
    const base = Math.floor(Date.UTC(2025, 5, 1, 12, 0, 0) / 1000);
    for (let i = 0; i < 25; i++) {
      const t = seedTrack(db, { path: `/music/p${i}.flac`, title: `P${i}`, artist: "A", album: "X", libraryFolderId: folderId });
      seedPlay(db, t, base + i * 300);
    }

    const res = getGeniusTypesWithAvailability(db);
    expect(res.clockValid).toBe(true);
    expect(res.firstLogDate).not.toBeNull();
    expect(res.types.find((t) => t.value === "late_night")?.available).toBe(true);
  });

  itDb("a single plausible row among bad ones does not vouch for the clock", () => {
    for (let i = 0; i < 30; i++) {
      const t = seedTrack(db, { path: `/music/b${i}.flac`, title: `B${i}`, artist: "A", album: "X", libraryFolderId: folderId });
      seedPlay(db, t, UNSET_CLOCK_TS + i * 300);
    }
    const good = seedTrack(db, { path: "/music/good.flac", title: "Good", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, good, Math.floor(Date.UTC(2025, 5, 1, 23, 30, 0) / 1000));

    expect(getGeniusTypesWithAvailability(db).clockValid).toBe(false);
  });

  itDb("recently_discovered still works when every timestamp is implausible", () => {
    // Regression guard: this generator uses timestamps only for ordering, so
    // it must NOT drop rows logged under a wrong clock — unlike late_night.
    const a = seedTrack(db, { path: "/music/r1.flac", title: "Tried", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, a, UNSET_CLOCK_TS, { elapsedMs: 195_000, totalMs: 200_000 });
    const b = seedTrack(db, { path: "/music/r2.flac", title: "Skipped", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, b, UNSET_CLOCK_TS + 600, { elapsedMs: 10_000, totalMs: 200_000 });

    const result = generateGeniusPlaylistFromDb("recently_discovered", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Tried"]);
  });

  itDb("late_night drops plays logged under an unset clock", () => {
    // 03:30 on a year-2000 stamp falls inside 22:00–05:00 by the raw hour, but
    // it is not a real late-night listen and must not be counted.
    const bogus = seedTrack(db, { path: "/music/bogus.flac", title: "Bogus", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, bogus, UNSET_CLOCK_TS, { elapsedMs: 190_000, totalMs: 200_000 });

    const result = generateGeniusPlaylistFromDb("late_night", db);
    expect(result.tracks).toHaveLength(0);
    expect(result.criteria).toMatch(/clock/i);
  });
});

describe("Genius engine — playback-derived generators", () => {
  let db: TestDb;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
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

  itDb("top_artist reports real play counts from playback_stats", () => {
    // Regression guard: these used to read tracks.play_count, a column nothing
    // writes, so every preview showed 0 plays.
    const t = seedTrack(db, { path: "/music/a1.flac", title: "Hit", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, t, Math.floor(Date.UTC(2025, 0, 15, 12, 0, 0) / 1000));
    seedPlay(db, t, Math.floor(Date.UTC(2025, 0, 15, 13, 0, 0) / 1000));
    aggregateStats(db);

    const result = generateGeniusPlaylistFromDb("top_artist", db);
    expect(result.tracks.map((x) => x.playCount)).toEqual([2]);
  });
});

describe("Genius engine — library-derived generators", () => {
  let db: TestDb;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("hidden_gems returns never-played tracks, with no playback history at all", () => {
    const unplayed = seedTrack(db, { path: "/music/h1.flac", title: "Unplayed", artist: "A", album: "X", libraryFolderId: folderId });
    const played = seedTrack(db, { path: "/music/h2.flac", title: "Played", artist: "B", album: "Y", libraryFolderId: folderId });
    seedPlay(db, played, Math.floor(Date.UTC(2025, 0, 15, 12, 0, 0) / 1000));

    const result = generateGeniusPlaylistFromDb("hidden_gems", db);
    const ids = result.tracks.map((t) => t.id);
    // RANDOM() ordering — assert membership, never order.
    expect(ids).toContain(unplayed);
    expect(ids).not.toContain(played);
  });

  itDb("hidden_gems runs on an empty playback log instead of erroring out", () => {
    seedTrack(db, { path: "/music/e1.flac", title: "Solo", artist: "A", album: "X", libraryFolderId: folderId });

    const result = generateGeniusPlaylistFromDb("hidden_gems", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Solo"]);
  });

  itDb("top_genre never crowns an untagged genre", () => {
    // Untagged track played more than the tagged one — it must still lose,
    // because "no genre" is not a genre.
    const untagged = seedTrack(db, { path: "/music/g0.flac", title: "Untagged", artist: "A", album: "X", libraryFolderId: folderId });
    seedPlay(db, untagged, 1_750_000_000);
    seedPlay(db, untagged, 1_750_000_100);
    seedPlay(db, untagged, 1_750_000_200);
    const rock = seedTrack(db, { path: "/music/g1.flac", title: "Rocker", artist: "B", album: "Y", genre: "Rock", libraryFolderId: folderId });
    seedPlay(db, rock, 1_750_000_300);
    seedTrack(db, { path: "/music/g2.flac", title: "Rocker2", artist: "B", album: "Y", genre: "Rock", libraryFolderId: folderId });

    const result = generateGeniusPlaylistFromDb("top_genre", db);
    expect(result.playlistName).toBe("Top Genre: Rock");
    expect(result.tracks.map((t) => t.title).sort()).toEqual(["Rocker", "Rocker2"]);
  });

  itDb("finish_album returns unheard tracks from part-played albums", () => {
    const ids: number[] = [];
    for (let i = 1; i <= 4; i++) {
      ids.push(seedTrack(db, { path: `/music/alb${i}.flac`, title: `Track${i}`, artist: "A", album: "Started", trackNumber: i, libraryFolderId: folderId }));
    }
    seedPlay(db, ids[0], 1_750_000_000);
    seedPlay(db, ids[1], 1_750_000_100);

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Track3", "Track4"]);
  });

  itDb("finish_album ignores tracks with no album", () => {
    // Album-less tracks must not collapse into one bogus group. Seeded with
    // distinct album titles so they cannot form a shared >=3-track album.
    for (let i = 1; i <= 5; i++) {
      const t = seedTrack(db, { path: `/music/loose${i}.flac`, title: `Loose${i}`, artist: `Artist${i}`, album: `Album${i}`, libraryFolderId: folderId });
      db.prepare("UPDATE tracks SET album_id = NULL WHERE id = ?").run(t);
      if (i === 1) seedPlay(db, t, 1_750_000_000);
    }

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks).toHaveLength(0);
  });

  itDb("finish_album skips fully-played and untouched albums", () => {
    const done: number[] = [];
    for (let i = 1; i <= 3; i++) {
      done.push(seedTrack(db, { path: `/music/done${i}.flac`, title: `Done${i}`, artist: "A", album: "Finished", trackNumber: i, libraryFolderId: folderId }));
    }
    done.forEach((id, i) => seedPlay(db, id, 1_750_000_000 + i * 100));
    for (let i = 1; i <= 3; i++) {
      seedTrack(db, { path: `/music/never${i}.flac`, title: `Never${i}`, artist: "B", album: "Untouched", trackNumber: i, libraryFolderId: folderId });
    }

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks).toHaveLength(0);
  });
});

describe("Genius engine — type registry", () => {
  let db: TestDb;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("returns 12 types, with only clock-dependent ones gated on a fresh profile", () => {
    const res = getGeniusTypesWithAvailability(db);
    expect(res.types).toHaveLength(12);
    expect(res.totalMatched).toBe(0);
    expect(res.dataMonths).toBe(0);
    expect(res.firstLogDate).toBeNull();

    const byValue = new Map(res.types.map((t) => [t.value, t]));
    // Types that need no history at all.
    expect(byValue.get("top_rated")?.available).toBe(true);
    expect(byValue.get("hidden_gems")?.available).toBe(true);
    // Count/completion types stay selectable; they just come back empty.
    expect(byValue.get("most_played")?.available).toBe(true);
    // Only the clock-dependent type is gated.
    expect(byValue.get("late_night")?.available).toBe(false);

    // The removed time-window types are gone for good.
    for (const dead of ["oldies", "nostalgia", "recent_favorites", "time_capsule", "golden_era"]) {
      expect(byValue.has(dead), dead).toBe(false);
    }
  });

  itDb("getAvailableGeniusTypes filters out gated types", () => {
    const values = getAvailableGeniusTypes(db).map((t) => t.value);
    expect(values).not.toContain("late_night");
    expect(values).toContain("hidden_gems");
    expect(values).toContain("top_genre");
    expect(values).toContain("finish_album");
  });
});
