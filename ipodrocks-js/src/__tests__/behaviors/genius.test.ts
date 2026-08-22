/**
 * @vitest-environment node
 *
 * Behavioral coverage for the Genius playlist engine, which reads the runtime
 * counters Rockbox records itself — play count, listening time, average
 * completion and play order — out of `device_runtime_stats` / `playback_stats`.
 *
 * Two properties of that data shape almost every test here:
 *
 *   * Rockbox only counts a play once a track has run 15 seconds, so a track
 *     skipped immediately is indistinguishable from one never played.
 *   * Rockbox attaches no date to a play. Period-scoped stats can therefore
 *     only count what iPodRocks has observed since it started watching, which
 *     is what `runtime_play_deltas` records.
 *
 * Drives the engine functions in `src/main/playlists/genius-engine.ts`
 * directly against an in-memory DB.
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

import {
  buildListeningStatsFromDb,
  generateGeniusPlaylistFromDb,
  getAvailableGeniusTypes,
  getGeniusTypesWithAvailability,
} from "../../main/playlists/genius-engine";

const itDb = it.skipIf(!canRunDbTests);

interface RuntimeInput {
  plays: number;
  /** Average completion 0..1. Defaults to a full listen. */
  completion?: number;
  /** Rockbox's play-order counter; ordering only, never a date. */
  serial?: number;
  /** Host-clock date recorded when an import saw the counter rise. */
  lastPlayedAt?: string;
  lengthMs?: number;
}

/**
 * Give a track the runtime counters a device import would have produced, and
 * refresh the library roll-up the generators actually read.
 */
function seedRuntime(
  db: TestDb,
  deviceId: number,
  trackId: number,
  input: RuntimeInput
): void {
  const lengthMs = input.lengthMs ?? 200_000;
  const completion = input.completion ?? 1;
  const playTimeMs = Math.round(lengthMs * input.plays * completion);

  db.prepare(
    `INSERT INTO device_runtime_stats
       (device_id, track_id, device_path, play_count, play_time_ms, rating,
        last_played_serial, length_ms, avg_completion, prev_play_count,
        last_played_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)
     ON CONFLICT(device_id, track_id) DO UPDATE SET
       play_count = excluded.play_count,
       play_time_ms = excluded.play_time_ms,
       avg_completion = excluded.avg_completion,
       last_played_serial = excluded.last_played_serial,
       last_played_at = excluded.last_played_at`
  ).run(
    deviceId,
    trackId,
    `music/track-${trackId}.flac`,
    input.plays,
    playTimeMs,
    input.serial ?? 0,
    lengthMs,
    completion,
    input.lastPlayedAt ?? null
  );

  rollUp(db);
}

/** Mirrors aggregateRuntimeStats in rockbox/runtime-ingest.ts. */
function rollUp(db: TestDb): void {
  db.prepare("DELETE FROM playback_stats").run();
  db.prepare(
    `INSERT INTO playback_stats
       (track_id, total_plays, total_playtime_ms, avg_completion_rate,
        last_played_at, first_played_at, updated_at)
     SELECT r.track_id, SUM(r.play_count), SUM(r.play_time_ms),
            CASE WHEN SUM(r.play_count) > 0
                 THEN SUM(COALESCE(r.avg_completion, 0) * r.play_count)
                      / SUM(r.play_count)
                 ELSE 0 END,
            MAX(r.last_played_at),
            (SELECT MIN(d.observed_at) FROM runtime_play_deltas d
              WHERE d.track_id = r.track_id),
            CURRENT_TIMESTAMP
       FROM device_runtime_stats r
      GROUP BY r.track_id`
  ).run();
}

/** Record an observed rise in a track's play count at a given host date. */
function seedDelta(
  db: TestDb,
  deviceId: number,
  trackId: number,
  observedAt: string,
  plays: number,
  playtimeMs = 200_000
): void {
  db.prepare(
    `INSERT INTO runtime_play_deltas
       (device_id, track_id, observed_at, plays_delta, playtime_delta_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(deviceId, trackId, observedAt, plays, playtimeMs);
  rollUp(db);
}

describe("Genius engine — counter-based generators", () => {
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

  function track(
    title: string,
    opts: {
      artist?: string;
      album?: string;
      genre?: string;
      rating?: number | null;
      trackNumber?: number;
    } = {}
  ): number {
    return seedTrack(db, {
      path: `/music/${title}.flac`,
      title,
      artist: opts.artist ?? "A",
      album: opts.album ?? "X",
      genre: opts.genre,
      rating: opts.rating ?? null,
      trackNumber: opts.trackNumber,
      libraryFolderId: folderId,
    });
  }

  itDb("most_played ranks by Rockbox's play count", () => {
    const a = track("Often");
    const b = track("Rarely");
    seedRuntime(db, deviceId, a, { plays: 9 });
    seedRuntime(db, deviceId, b, { plays: 1 });

    const result = generateGeniusPlaylistFromDb("most_played", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Often", "Rarely"]);
    expect(result.tracks[0].playCount).toBe(9);
  });

  itDb("most_played honours a minimum play count", () => {
    seedRuntime(db, deviceId, track("Once"), { plays: 1 });
    seedRuntime(db, deviceId, track("Lots"), { plays: 6 });

    const result = generateGeniusPlaylistFromDb("most_played", db, { minPlays: 5 });
    expect(result.tracks.map((t) => t.title)).toEqual(["Lots"]);
  });

  itDb("favorites needs both high completion and repeat plays", () => {
    seedRuntime(db, deviceId, track("Loved"), { plays: 4, completion: 0.95 });
    // Completed, but only once — not yet a favourite.
    seedRuntime(db, deviceId, track("Tried"), { plays: 1, completion: 1 });
    // Played often, but never all the way through.
    seedRuntime(db, deviceId, track("Background"), { plays: 8, completion: 0.4 });

    const result = generateGeniusPlaylistFromDb("favorites", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Loved"]);
  });

  itDb("skip_list means never finished, not never played", () => {
    // Rockbox does not record a skip at all, so a track with no plays cannot
    // be judged: it might be unplayed, or skipped every time. Only a track
    // that *has* plays and keeps being abandoned qualifies.
    const abandoned = track("Abandoned");
    seedRuntime(db, deviceId, abandoned, { plays: 5, completion: 0.1 });
    seedRuntime(db, deviceId, track("Finished"), { plays: 5, completion: 0.98 });
    track("NeverTouched");

    const result = generateGeniusPlaylistFromDb("skip_list", db);
    expect(result.playlistName).toBe("Never Finished");
    expect(result.tracks.map((t) => t.title)).toEqual(["Abandoned"]);
  });

  itDb("top_artist weights by play count, not by how many tracks have counters", () => {
    // The regression this pins: tallying one point per track with a counter
    // would crown Prolific (3 tracks, 3 plays) over Beloved (1 track, 40).
    for (let i = 1; i <= 3; i++) {
      seedRuntime(db, deviceId, track(`Filler${i}`, { artist: "Prolific" }), {
        plays: 1,
      });
    }
    seedRuntime(db, deviceId, track("Anthem", { artist: "Beloved" }), {
      plays: 40,
    });

    const result = generateGeniusPlaylistFromDb("top_artist", db);
    expect(result.playlistName).toBe("Top Artist: Beloved");
  });

  itDb("top_album weights by play count too", () => {
    for (let i = 1; i <= 4; i++) {
      seedRuntime(
        db,
        deviceId,
        track(`Thin${i}`, { artist: "A", album: "Sampled" }),
        { plays: 1 }
      );
    }
    seedRuntime(
      db,
      deviceId,
      track("Hit", { artist: "A", album: "Adored" }),
      { plays: 30 }
    );

    const result = generateGeniusPlaylistFromDb("top_album", db);
    expect(result.playlistName).toBe("Top Album: Adored");
  });

  itDb("recently_discovered takes single plays heard right through", () => {
    seedRuntime(db, deviceId, track("Newer"), {
      plays: 1,
      completion: 0.95,
      serial: 9,
    });
    seedRuntime(db, deviceId, track("Older"), {
      plays: 1,
      completion: 0.95,
      serial: 2,
    });
    // Heard once but abandoned — tried, not liked.
    seedRuntime(db, deviceId, track("Bailed"), {
      plays: 1,
      completion: 0.3,
      serial: 10,
    });
    // Liked, but no longer a discovery.
    seedRuntime(db, deviceId, track("Familiar"), { plays: 6, completion: 1 });

    const result = generateGeniusPlaylistFromDb("recently_discovered", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Newer", "Older"]);
  });

  itDb("recently_discovered prefers a real date over the play-order serial", () => {
    // The serial says Serialled is more recent; the host-clock date on Dated
    // is the stronger signal and must win.
    seedRuntime(db, deviceId, track("Serialled"), {
      plays: 1,
      completion: 1,
      serial: 500,
    });
    seedRuntime(db, deviceId, track("Dated"), {
      plays: 1,
      completion: 1,
      serial: 1,
      lastPlayedAt: "2026-08-01T10:00:00.000Z",
    });

    const result = generateGeniusPlaylistFromDb("recently_discovered", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Dated", "Serialled"]);
  });

  itDb("forgotten_favorites surfaces well-liked tracks left longest", () => {
    const stale = track("Stale", { rating: 9 });
    const recent = track("Recent", { rating: 9 });
    seedRuntime(db, deviceId, stale, { plays: 2, serial: 1 });
    seedRuntime(db, deviceId, recent, { plays: 2, serial: 90 });
    // Neither well rated nor often played.
    seedRuntime(db, deviceId, track("Meh"), { plays: 1, serial: 2 });

    const result = generateGeniusPlaylistFromDb("forgotten_favorites", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Stale", "Recent"]);
  });

  itDb("deep_dive orders one artist's library by play count", () => {
    const hit = track("Hit", { artist: "Focus" });
    const deep = track("Deep", { artist: "Focus" });
    track("Elsewhere", { artist: "Other" });
    seedRuntime(db, deviceId, hit, { plays: 12 });
    seedRuntime(db, deviceId, deep, { plays: 1 });

    const result = generateGeniusPlaylistFromDb("deep_dive", db, {
      artist: "Focus",
    });
    expect(result.tracks.map((t) => t.title)).toEqual(["Hit", "Deep"]);
  });

  itDb("top_genre sums play counts rather than counting tracks", () => {
    for (let i = 1; i <= 3; i++) {
      seedRuntime(db, deviceId, track(`Jazzy${i}`, { genre: "Jazz" }), {
        plays: 1,
      });
    }
    const rocker = track("Rocker", { genre: "Rock" });
    seedRuntime(db, deviceId, rocker, { plays: 20 });
    track("Rocker2", { genre: "Rock" });

    const result = generateGeniusPlaylistFromDb("top_genre", db);
    expect(result.playlistName).toBe("Top Genre: Rock");
    expect(result.tracks.map((t) => t.title).sort()).toEqual([
      "Rocker",
      "Rocker2",
    ]);
  });

  itDb("top_genre never crowns an untagged genre", () => {
    // Untagged track played more than the tagged one — it must still lose,
    // because "no genre" is not a genre.
    seedRuntime(db, deviceId, track("Untagged"), { plays: 30 });
    const rock = track("Rocker", { genre: "Rock" });
    seedRuntime(db, deviceId, rock, { plays: 1 });
    track("Rocker2", { genre: "Rock" });

    const result = generateGeniusPlaylistFromDb("top_genre", db);
    expect(result.playlistName).toBe("Top Genre: Rock");
  });
});

describe("Genius engine — library-derived generators", () => {
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

  function track(title: string, opts: Record<string, unknown> = {}): number {
    return seedTrack(db, {
      path: `/music/${title}.flac`,
      title,
      artist: (opts.artist as string) ?? "A",
      album: (opts.album as string) ?? "X",
      trackNumber: opts.trackNumber as number | undefined,
      libraryFolderId: folderId,
    });
  }

  itDb("hidden_gems returns tracks with no plays recorded", () => {
    const unplayed = track("Unplayed");
    const played = track("Played", { artist: "B", album: "Y" });
    seedRuntime(db, deviceId, played, { plays: 3 });

    const result = generateGeniusPlaylistFromDb("hidden_gems", db);
    const ids = result.tracks.map((t) => t.id);
    // RANDOM() ordering — assert membership, never order.
    expect(ids).toContain(unplayed);
    expect(ids).not.toContain(played);
  });

  itDb("hidden_gems runs on a library with no play history at all", () => {
    track("Solo");
    const result = generateGeniusPlaylistFromDb("hidden_gems", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Solo"]);
  });

  itDb("top_rated works without any play history", () => {
    seedTrack(db, {
      path: "/music/great.flac",
      title: "Great",
      artist: "A",
      album: "X",
      rating: 10,
      libraryFolderId: folderId,
    });
    seedTrack(db, {
      path: "/music/ok.flac",
      title: "Ok",
      artist: "A",
      album: "X",
      rating: 4,
      libraryFolderId: folderId,
    });

    const result = generateGeniusPlaylistFromDb("top_rated", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Great"]);
  });

  itDb("finish_album returns unheard tracks from part-played albums", () => {
    const ids: number[] = [];
    for (let i = 1; i <= 4; i++) {
      ids.push(track(`Track${i}`, { album: "Started", trackNumber: i }));
    }
    seedRuntime(db, deviceId, ids[0], { plays: 1 });
    seedRuntime(db, deviceId, ids[1], { plays: 1 });

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks.map((t) => t.title)).toEqual(["Track3", "Track4"]);
  });

  itDb("finish_album ignores tracks with no album", () => {
    // Album-less tracks must not collapse into one bogus group. Seeded with
    // distinct album titles so they cannot form a shared >=3-track album.
    for (let i = 1; i <= 5; i++) {
      const t = track(`Loose${i}`, { artist: `Artist${i}`, album: `Album${i}` });
      db.prepare("UPDATE tracks SET album_id = NULL WHERE id = ?").run(t);
      if (i === 1) seedRuntime(db, deviceId, t, { plays: 1 });
    }

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks).toHaveLength(0);
  });

  itDb("finish_album skips fully-played and untouched albums", () => {
    const done: number[] = [];
    for (let i = 1; i <= 3; i++) {
      done.push(track(`Done${i}`, { album: "Finished", trackNumber: i }));
    }
    for (const id of done) seedRuntime(db, deviceId, id, { plays: 1 });
    for (let i = 1; i <= 3; i++) {
      track(`Never${i}`, { artist: "B", album: "Untouched", trackNumber: i });
    }

    const result = generateGeniusPlaylistFromDb("finish_album", db);
    expect(result.tracks).toHaveLength(0);
  });
});

describe("Genius engine — buildListeningStatsFromDb", () => {
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

  function track(title: string, opts: Record<string, unknown> = {}): number {
    return seedTrack(db, {
      path: `/music/${title}.flac`,
      title,
      artist: (opts.artist as string) ?? "A",
      album: "X",
      genre: opts.genre as string | undefined,
      libraryFolderId: folderId,
    });
  }

  itDb("reports a well-formed zero result on a fresh library", () => {
    for (const period of ["all", "year", "month"] as const) {
      const stats = buildListeningStatsFromDb(db, period);
      expect(stats).toMatchObject({
        period,
        totalPlays: 0,
        totalListeningTimeMs: 0,
        uniqueTracksPlayed: 0,
        topTracks: [],
        topArtists: [],
        topGenre: null,
        totalLibraryPlays: 0,
      });
    }
  });

  itDb("all-time totals come from every counter Rockbox has recorded", () => {
    const a = track("Top", { artist: "Alpha", genre: "Rock" });
    const b = track("Second", { artist: "Beta", genre: "Rock" });
    seedRuntime(db, deviceId, a, { plays: 20, lengthMs: 100_000 });
    seedRuntime(db, deviceId, b, { plays: 5, lengthMs: 100_000 });

    const stats = buildListeningStatsFromDb(db, "all");
    expect(stats.totalPlays).toBe(25);
    expect(stats.uniqueTracksPlayed).toBe(2);
    expect(stats.totalListeningTimeMs).toBe(2_500_000);
    expect(stats.topTracks[0]).toMatchObject({ title: "Top", playCount: 20 });
    expect(stats.topArtists[0]).toMatchObject({ name: "Alpha", playCount: 20 });
    expect(stats.topGenre).toMatchObject({ name: "Rock", playCount: 25 });
  });

  itDb("year and month count only what was observed inside them", () => {
    // Rockbox dates nothing, so a period can only cover the rises iPodRocks
    // has actually watched happen.
    const t = track("Dated");
    seedRuntime(db, deviceId, t, { plays: 10 });
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 2).toISOString();
    const earlierThisYear = new Date(now.getFullYear(), 0, 2).toISOString();
    const lastYear = new Date(now.getFullYear() - 1, 5, 2).toISOString();

    seedDelta(db, deviceId, t, thisMonth, 3);
    seedDelta(db, deviceId, t, earlierThisYear, 4);
    seedDelta(db, deviceId, t, lastYear, 3);

    expect(buildListeningStatsFromDb(db, "all").totalPlays).toBe(10);
    // Both of this year's observations count; last year's does not.
    expect(buildListeningStatsFromDb(db, "year").totalPlays).toBe(7);
    // January 2nd falls inside "this month" only during January.
    expect(buildListeningStatsFromDb(db, "month").totalPlays).toBe(
      now.getMonth() === 0 ? 7 : 3
    );
  });

  itDb("an empty period still reports the library total, so the UI can say why", () => {
    // A library full of plays can legitimately show zero for this month: the
    // counters predate iPodRocks watching them. Saying "no listening data" there
    // would be wrong.
    seedRuntime(db, deviceId, track("Old"), { plays: 40 });

    const stats = buildListeningStatsFromDb(db, "month");
    expect(stats.totalPlays).toBe(0);
    expect(stats.totalLibraryPlays).toBe(40);
  });
});

describe("Genius engine — type registry", () => {
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

  itDb("offers 12 types, gating the counter-based ones on a fresh profile", () => {
    const res = getGeniusTypesWithAvailability(db);
    expect(res.types).toHaveLength(12);
    expect(res.tracksWithPlays).toBe(0);
    expect(res.totalPlays).toBe(0);
    expect(res.deviceCount).toBe(0);

    const byValue = new Map(res.types.map((t) => [t.value, t]));
    // These read library metadata only, so they work with no device at all.
    expect(byValue.get("top_rated")?.available).toBe(true);
    expect(byValue.get("hidden_gems")?.available).toBe(true);
    // Everything else needs counters, and says how to get them.
    expect(byValue.get("most_played")?.available).toBe(false);
    expect(byValue.get("most_played")?.unavailableReason).toMatch(
      /Gather Runtime Data/
    );
  });

  itDb("no longer offers a time-of-day type", () => {
    // Rockbox's runtime data carries no clock at all, so late_night cannot be
    // computed from it and was removed rather than faked.
    const values = getGeniusTypesWithAvailability(db).types.map((t) => t.value);
    expect(values).not.toContain("late_night");
    expect(values).toContain("forgotten_favorites");
  });

  itDb("unlocks the counter-based types once a device has recorded plays", () => {
    const t = seedTrack(db, {
      path: "/music/x.flac",
      title: "X",
      artist: "A",
      album: "Y",
      libraryFolderId: folderId,
    });
    seedRuntime(db, deviceId, t, { plays: 3 });

    const res = getGeniusTypesWithAvailability(db);
    expect(res.tracksWithPlays).toBe(1);
    expect(res.totalPlays).toBe(3);
    expect(res.deviceCount).toBe(1);
    expect(res.types.every((x) => x.available !== false)).toBe(true);
  });

  itDb("getAvailableGeniusTypes filters out the gated ones", () => {
    const values = getAvailableGeniusTypes(db).map((t) => t.value);
    expect(values).toContain("top_rated");
    expect(values).toContain("hidden_gems");
    expect(values).not.toContain("most_played");
    expect(values).not.toContain("top_genre");
  });
});
