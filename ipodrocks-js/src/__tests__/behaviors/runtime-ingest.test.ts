/**
 * @vitest-environment node
 *
 * Importing Rockbox's runtime counters, and the path matching that decides
 * which library track each one belongs to.
 *
 * Two properties matter most here. Runtime data is a set of absolute totals,
 * not a log, so importing an unchanged device twice must change nothing. And a
 * counter landing on the wrong track is silent and permanent, so every
 * ambiguous match has to come back unmatched rather than guessed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  cleanupTmp,
  closeDb,
  createTestDb,
  createTmpDir,
  seedDevice,
  seedLibraryFolder,
  seedTrack,
  writeTcdFixture,
  type TestDb,
} from "../harness";

import { readAndIngestRuntimeData } from "../../main/rockbox/runtime-ingest";

const itDb = it.skipIf(!canRunDbTests);

describe("Rockbox runtime data import", () => {
  let db: TestDb;
  let mount: string;
  let deviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    mount = createTmpDir("runtime-");
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: mount });
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(mount);
  });

  /** A library track plus the device_synced_tracks row a device check writes. */
  function seedSynced(
    title: string,
    devicePath: string,
    opts: { artist?: string; album?: string } = {}
  ): number {
    const libPath = `/music/${title}.mp3`;
    const trackId = seedTrack(db, {
      path: libPath,
      title,
      artist: opts.artist ?? "Artist",
      album: opts.album ?? "Album",
      libraryFolderId: folderId,
    });
    db.prepare(
      "INSERT INTO device_synced_tracks (device_id, library_path, device_path) VALUES (?, ?, ?)"
    ).run(deviceId, libPath, devicePath);
    return trackId;
  }

  function runtimeRow(trackId: number) {
    return db
      .prepare(
        "SELECT * FROM device_runtime_stats WHERE device_id = ? AND track_id = ?"
      )
      .get(deviceId, trackId) as Record<string, unknown> | undefined;
  }

  function ingest() {
    return readAndIngestRuntimeData(db, deviceId, mount, false);
  }

  describe("importing counters", () => {
    itDb("stores play count, listening time and rating", () => {
      const id = seedSynced("One", "Music/Artist/Album/One.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/One.mp3",
          playCount: 4,
          playTimeMs: 800_000,
          rating: 8,
          lengthMs: 200_000,
          lastPlayedSerial: 3,
        },
      ]);

      const result = ingest();
      expect(result.imported).toBe(1);
      expect(result.unmatched).toBe(0);

      expect(runtimeRow(id)).toMatchObject({
        play_count: 4,
        play_time_ms: 800_000,
        rating: 8,
        last_played_serial: 3,
      });
    });

    itDb("computes average completion the way Rockbox's autoscore does", () => {
      const id = seedSynced("Half", "Music/Artist/Album/Half.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/Half.mp3",
          playCount: 2,
          playTimeMs: 200_000, // 2 plays of a 200s track, half listened each
          lengthMs: 200_000,
        },
      ]);

      ingest();
      expect(runtimeRow(id)!.avg_completion).toBeCloseTo(0.5, 5);
    });

    itDb("clamps completion when Rockbox credits crossfade past the end", () => {
      // Rockbox adds up to 15s beyond the track length per play, so playtime
      // can legitimately exceed length * playcount.
      const id = seedSynced("Over", "Music/Artist/Album/Over.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/Over.mp3",
          playCount: 1,
          playTimeMs: 215_000,
          lengthMs: 200_000,
        },
      ]);

      ingest();
      expect(runtimeRow(id)!.avg_completion).toBe(1);
    });

    itDb("records a never-played track as zero plays, not as absent", () => {
      const id = seedSynced("Quiet", "Music/Artist/Album/Quiet.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Quiet.mp3", playCount: 0 },
        { path: "/<HDD0>/Music/Artist/Album/Loud.mp3", playCount: 5 },
      ]);

      const result = ingest();
      expect(result.state.kind).toBe("ok");
      expect(runtimeRow(id)).toMatchObject({ play_count: 0 });
    });

    itDb("stores an unrated track as null rather than as a zero rating", () => {
      // Rockbox has no null; 0 is how it says "never rated".
      const id = seedSynced("Unrated", "Music/Artist/Album/Unrated.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Unrated.mp3", rating: 0 },
      ]);

      ingest();
      expect(runtimeRow(id)!.rating).toBeNull();
    });

    itDb("rolls the counters up into playback_stats", () => {
      const a = seedSynced("A", "Music/Artist/Album/A.mp3");
      seedSynced("B", "Music/Artist/Album/B.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/A.mp3",
          playCount: 3,
          playTimeMs: 600_000,
          lengthMs: 200_000,
        },
        { path: "/<HDD0>/Music/Artist/Album/B.mp3" },
      ]);

      ingest();

      const stats = db
        .prepare("SELECT * FROM playback_stats WHERE track_id = ?")
        .get(a) as Record<string, unknown>;
      expect(stats).toMatchObject({
        total_plays: 3,
        total_playtime_ms: 600_000,
      });
      expect(stats.avg_completion_rate).toBeCloseTo(1, 5);
    });
  });

  describe("idempotence", () => {
    itDb("importing the same snapshot twice changes nothing", () => {
      const id = seedSynced("Same", "Music/Artist/Album/Same.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/Same.mp3",
          playCount: 2,
          playTimeMs: 400_000,
          lengthMs: 200_000,
        },
      ]);

      ingest();
      const first = runtimeRow(id);
      const second = ingest();

      expect(second.newPlays).toBe(0);
      expect(runtimeRow(id)!.play_count).toBe(first!.play_count);
      expect(runtimeRow(id)!.last_played_at).toBe(first!.last_played_at);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM runtime_play_deltas").get()
      ).toMatchObject({ n: 0 });
    });
  });

  describe("deriving a date Rockbox does not provide", () => {
    itDb("the first import sets the baseline without inventing a date", () => {
      const id = seedSynced("First", "Music/Artist/Album/First.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/First.mp3", playCount: 9 },
      ]);

      const result = ingest();
      expect(result.newPlays).toBe(0);
      expect(runtimeRow(id)!.last_played_at).toBeNull();
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM runtime_play_deltas").get()
      ).toMatchObject({ n: 0 });
    });

    itDb("a later import stamps the rise with the host clock", () => {
      const id = seedSynced("Later", "Music/Artist/Album/Later.mp3");
      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/Later.mp3",
          playCount: 1,
          playTimeMs: 200_000,
          lengthMs: 200_000,
        },
      ]);
      ingest();

      writeTcdFixture(mount, [
        {
          path: "/<HDD0>/Music/Artist/Album/Later.mp3",
          playCount: 3,
          playTimeMs: 600_000,
          lengthMs: 200_000,
        },
      ]);
      const result = ingest();

      expect(result.newPlays).toBe(1);
      const row = runtimeRow(id)!;
      expect(row.prev_play_count).toBe(1);
      expect(row.play_count).toBe(3);
      expect(String(row.last_played_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The date is this machine's clock, not the device's year-2000 RTC.
      expect(new Date(String(row.last_played_at)).getUTCFullYear()).toBe(
        new Date().getUTCFullYear()
      );

      const delta = db
        .prepare("SELECT * FROM runtime_play_deltas WHERE track_id = ?")
        .get(id) as Record<string, unknown>;
      expect(delta).toMatchObject({
        plays_delta: 2,
        playtime_delta_ms: 400_000,
      });
    });
  });

  describe("matching", () => {
    itDb("matches on the exact device path", () => {
      const id = seedSynced("Exact", "Music/Artist/Album/Exact.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Exact.mp3", playCount: 1 },
      ]);
      expect(ingest().imported).toBe(1);
      expect(runtimeRow(id)).toBeDefined();
    });

    itDb("ignores case and the volume token Rockbox prefixes", () => {
      const id = seedSynced("Case", "Music/Artist/Album/Case.mp3");
      writeTcdFixture(mount, [
        { path: "/<microSD0>/MUSIC/ARTIST/ALBUM/CASE.MP3", playCount: 2 },
      ]);
      expect(ingest().imported).toBe(1);
      expect(runtimeRow(id)!.play_count).toBe(2);
    });

    itDb("matches across Unicode normalisation forms", () => {
      // macOS hands back decomposed filenames; the same name in NFD compares
      // unequal to itself in NFC.
      const nfc = "Björk";
      const nfd = "Björk";
      const id = seedSynced("Nfc", `Music/${nfc}/Album/Song.mp3`);
      writeTcdFixture(mount, [
        { path: `/<HDD0>/Music/${nfd}/Album/Song.mp3`, playCount: 3 },
      ]);
      expect(ingest().imported).toBe(1);
      expect(runtimeRow(id)!.play_count).toBe(3);
    });

    itDb("falls back to artist/album/filename when device_path is unknown", () => {
      // Rows written before device_path existed, or a device never checked.
      const libPath = "/music/Fallback.mp3";
      const trackId = seedTrack(db, {
        path: libPath,
        title: "Fallback",
        artist: "Artist",
        album: "Album",
        libraryFolderId: folderId,
      });
      db.prepare(
        "INSERT INTO device_synced_tracks (device_id, library_path) VALUES (?, ?)"
      ).run(deviceId, libPath);

      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Fallback.mp3", playCount: 6 },
      ]);

      expect(ingest().imported).toBe(1);
      expect(runtimeRow(trackId)!.play_count).toBe(6);
    });

    itDb("leaves an ambiguous filename unmatched rather than guessing", () => {
      // The real trap: two files in one album whose basenames collide once the
      // folder is stripped. Assigning either one's plays to the other is
      // invisible and permanent, so neither is claimed.
      for (const artist of ["Artist One", "Artist Two"]) {
        const libPath = `/music/${artist}/Track.mp3`;
        seedTrack(db, {
          path: libPath,
          title: "Track",
          artist,
          album: "Split",
          libraryFolderId: folderId,
        });
        db.prepare(
          "INSERT INTO device_synced_tracks (device_id, library_path) VALUES (?, ?)"
        ).run(deviceId, libPath);
      }

      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Unknown/Track.mp3", playCount: 9 },
      ]);

      const result = ingest();
      expect(result.imported).toBe(0);
      expect(result.unmatched).toBe(1);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM device_runtime_stats").get()
      ).toMatchObject({ n: 0 });
    });

    itDb("reports records that match nothing in the library", () => {
      seedSynced("Known", "Music/Artist/Album/Known.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Known.mp3", playCount: 1 },
        { path: "/<HDD0>/Music/Stranger/Album/Gone.mp3", playCount: 4 },
      ]);

      const result = ingest();
      expect(result.imported).toBe(1);
      expect(result.unmatched).toBe(1);
    });
  });

  describe("when there is nothing to import", () => {
    itDb("reports a device with no Rockbox database", () => {
      const result = ingest();
      expect(result.imported).toBe(0);
      expect(result.state.kind).toBe("no-database");
    });

    itDb("reports a device that has never gathered runtime data", () => {
      seedSynced("Idle", "Music/Artist/Album/Idle.mp3");
      writeTcdFixture(
        mount,
        [{ path: "/<HDD0>/Music/Artist/Album/Idle.mp3" }],
        { serial: 0 }
      );

      const result = ingest();
      expect(result.imported).toBe(0);
      expect(result.state.kind).toBe("no-runtime-data");
    });

    itDb("honours the per-device opt-out without touching the device", () => {
      seedSynced("Opted", "Music/Artist/Album/Opted.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Opted.mp3", playCount: 5 },
      ]);

      const result = readAndIngestRuntimeData(db, deviceId, mount, true);
      expect(result.imported).toBe(0);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM device_runtime_stats").get()
      ).toMatchObject({ n: 0 });
    });
  });

  describe("tracks leaving the device", () => {
    itDb("drops counters for a track the device no longer holds", () => {
      const a = seedSynced("Stays", "Music/Artist/Album/Stays.mp3");
      const b = seedSynced("Goes", "Music/Artist/Album/Goes.mp3");
      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Stays.mp3", playCount: 1 },
        { path: "/<HDD0>/Music/Artist/Album/Goes.mp3", playCount: 2 },
      ]);
      ingest();
      expect(runtimeRow(b)).toBeDefined();

      writeTcdFixture(mount, [
        { path: "/<HDD0>/Music/Artist/Album/Stays.mp3", playCount: 1 },
      ]);
      ingest();

      expect(runtimeRow(a)).toBeDefined();
      expect(runtimeRow(b)).toBeUndefined();
    });
  });
});
