/**
 * @vitest-environment node
 *
 * Ratings travelling both ways between the library and Rockbox's own database.
 *
 * The transport this replaces could not work. iPodRocks wrote
 * `database_changelog.txt` in a format Rockbox does not use (tab-separated
 * `path\trating=N`, where the real format is `## Changelog version 1` followed
 * by `tag="value"` pairs), and Rockbox's importer skips any entry already
 * flagged FLAG_DIRTYNUM — that is, any track ever played or rated. Ratings now
 * go straight into the record Rockbox reads, exactly as Rockbox writes them
 * itself.
 *
 * Exercises the two sync phases against a real fixture database: ingest
 * (device → library, via the runtime import feeding `ingestDeviceRatings`) and
 * propagate (library → device, via `computeRatingPropagations` feeding
 * `writeRating`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

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
  readTcdNumericTag,
  TCD_TAG,
  type TestDb,
} from "../harness";

import { readAndIngestRuntimeData } from "../../main/rockbox/runtime-ingest";
import { writeRating, resetBackupState } from "../../main/rockbox/tagcache-index";
import {
  ingestDeviceRatings,
  computeRatingPropagations,
  markRatingsPropagated,
} from "../../main/sync/rating-merge";

const itDb = it.skipIf(!canRunDbTests);

const FLAG_DIRTYNUM = 0x4;
const DEVICE_PATH = "Music/Artist/Album/Song.mp3";
const ROCKBOX_PATH = "/<HDD0>/Music/Artist/Album/Song.mp3";

describe("rating sync over Rockbox's own database", () => {
  let db: TestDb;
  let mount: string;
  let deviceId: number;
  let trackId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    mount = createTmpDir("rating-wb-");
    resetBackupState();

    const folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: mount });
    trackId = seedTrack(db, {
      path: "/music/Song.mp3",
      title: "Song",
      artist: "Artist",
      album: "Album",
      libraryFolderId: folderId,
    });
    db.prepare(
      "INSERT INTO device_synced_tracks (device_id, library_path, device_path) VALUES (?, ?, ?)"
    ).run(deviceId, "/music/Song.mp3", DEVICE_PATH);
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(mount);
  });

  /** Phase 1: read the device's runtime data and merge its ratings in. */
  function ingest() {
    const imported = readAndIngestRuntimeData(db, deviceId, mount, false);
    const result = ingestDeviceRatings(db, deviceId, imported.ratings);
    return { imported, result };
  }

  /** Phase 3: push the library's canonical ratings back to the device. */
  function propagate(idxIds: Map<number, number>): number {
    const propagations = computeRatingPropagations(db, deviceId);
    const pushed: number[] = [];
    let written = 0;
    for (const [id, rating] of propagations) {
      const idxId = idxIds.get(id);
      if (idxId === undefined) continue;
      if (writeRating(mount, idxId, rating)) written++;
      pushed.push(id);
    }
    markRatingsPropagated(db, deviceId, pushed);
    return written;
  }

  function libraryRating(): number | null {
    return (
      db.prepare("SELECT rating FROM tracks WHERE id = ?").get(trackId) as {
        rating: number | null;
      }
    ).rating;
  }

  function setLibraryRating(rating: number): void {
    db.prepare(
      "UPDATE tracks SET rating = ?, rating_version = COALESCE(rating_version, 0) + 1 WHERE id = ?"
    ).run(rating, trackId);
  }

  itDb("a rating set on the device lands in the library", () => {
    writeTcdFixture(mount, [
      { path: ROCKBOX_PATH, playCount: 3, playTimeMs: 600_000, rating: 10 },
    ]);

    const { result } = ingest();
    expect(result.adopted).toBe(1);
    expect(libraryRating()).toBe(10);
  });

  itDb("an unrated track on the device does not overwrite a library rating", () => {
    setLibraryRating(6);
    // Rockbox has no null; 0 is how it says "never rated".
    writeTcdFixture(mount, [{ path: ROCKBOX_PATH, playCount: 1, rating: 0 }]);

    ingest();
    expect(libraryRating()).toBe(6);
  });

  itDb("a rating set in the library is written into the device's database", () => {
    const idxIds = writeTcdFixture(mount, [
      { path: ROCKBOX_PATH, playCount: 2, playTimeMs: 400_000 },
    ]);
    const { imported } = ingest();

    setLibraryRating(8);
    expect(propagate(imported.idxIds)).toBe(1);

    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.rating)).toBe(8);
    // The dirty flag is what makes the value survive a database rebuild on the
    // device; without it Rockbox discards it on the next Initialize Now.
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.flag) & FLAG_DIRTYNUM).toBe(
      FLAG_DIRTYNUM
    );
    // Nothing else about the track moved.
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.playcount)).toBe(2);
  });

  itDb("a track Rockbox has already touched still accepts a rating", () => {
    // The exact case the changelog transport could never handle: Rockbox's own
    // importer skips any entry already flagged DIRTYNUM, which is every track
    // that has ever been played or rated.
    const idxIds = writeTcdFixture(mount, [
      {
        path: ROCKBOX_PATH,
        playCount: 5,
        playTimeMs: 1_000_000,
        rating: 4,
        flag: FLAG_DIRTYNUM,
      },
    ]);
    const { imported } = ingest();

    setLibraryRating(10);
    expect(propagate(imported.idxIds)).toBe(1);
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.rating)).toBe(10);
  });

  itDb("a second sync with nothing to say writes no bytes", () => {
    const idxFile = path.join(mount, ".rockbox", "database_idx.tcd");
    writeTcdFixture(mount, [{ path: ROCKBOX_PATH, playCount: 1 }]);
    const { imported } = ingest();

    setLibraryRating(9);
    propagate(imported.idxIds);
    const after = fs.readFileSync(idxFile);

    // Re-import so the device's new rating becomes the known baseline, then
    // push again with nothing changed on either side.
    const second = ingest();
    propagate(second.imported.idxIds);

    expect(fs.readFileSync(idxFile).equals(after)).toBe(true);
  });

  itDb("changed on both sides queues a conflict instead of overwriting", () => {
    // Establish a shared baseline both sides agree on.
    const idxIds = writeTcdFixture(mount, [{ path: ROCKBOX_PATH, playCount: 1, rating: 6 }]);
    ingest();
    expect(libraryRating()).toBe(6);

    // The library moves to 10; the device independently moves to 2.
    setLibraryRating(10);
    writeTcdFixture(mount, [{ path: ROCKBOX_PATH, playCount: 1, rating: 2 }]);

    const { result } = ingest();
    expect(result.conflicts).toBe(1);

    const conflict = db
      .prepare(
        "SELECT reported_rating, baseline_rating FROM rating_conflicts WHERE track_id = ? AND resolved_at IS NULL"
      )
      .get(trackId) as { reported_rating: number; baseline_rating: number };
    expect(conflict.reported_rating).toBe(2);
    expect(conflict.baseline_rating).toBe(6);

    // Neither side is silently overwritten while the conflict stands.
    expect(libraryRating()).toBe(10);
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.rating)).toBe(2);
  });

  itDb("the device database is backed up before the first write to it", () => {
    const idxIds = writeTcdFixture(mount, [{ path: ROCKBOX_PATH, playCount: 1 }]);
    const { imported } = ingest();
    const backup = path.join(mount, ".rockbox", "database_idx.tcd.ipodrocks-bak");

    // Reading alone must not leave a backup behind.
    expect(fs.existsSync(backup)).toBe(false);

    setLibraryRating(7);
    propagate(imported.idxIds);

    expect(fs.existsSync(backup)).toBe(true);
    // The copy holds the pre-write state — the file has no checksum and no
    // redundancy, so a bad write would otherwise be unrecoverable.
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.rating)).toBe(7);
    const saved = fs.readFileSync(backup);
    expect(saved.readInt32LE(24 + idxIds[0] * 96 + TCD_TAG.rating * 4)).toBe(0);
  });
});
