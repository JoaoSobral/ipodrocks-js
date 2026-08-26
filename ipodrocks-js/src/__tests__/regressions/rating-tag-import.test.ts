/**
 * @vitest-environment node
 *
 * Issue #118 — ratings set in an external library manager (Swinsian, in the
 * report) never reached iPodRocks, because nothing ever read a rating out of
 * the file's own tag. Per the maintainer's reply on the issue: iPodRocks does
 * not write back to the library and does not special-case any one tool — it
 * reads whichever rating tag music-metadata already normalizes (ID3 POPM,
 * Vorbis `RATING`, …) onto the same 0-10 scale Rockbox and iPodRocks share
 * (see tcd-format.ts's TAG.rating), and only ever seeds a rating no one has
 * given yet.
 *
 * These tests drive the real `LibraryScanner` against the shared
 * music-metadata mock, so the scan path — including the upsert's
 * seed-only-if-null SQL — runs for real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  createTmpDir,
  cleanupTmp,
  installMusicMetadataMock,
  resetMusicMetadataMock,
  seedAudioFile,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

installMusicMetadataMock();

import { LibraryScanner } from "../../main/library/library-scanner";
import { ratingFromCommonTags } from "../../main/library/metadata-extractor";
import { isRatingTagBackfillDone } from "../../main/library/rating-tag-backfill";

const itDb = it.skipIf(!canRunDbTests);

function trackRating(db: TestDb, title: string): number | null {
  const row = db
    .prepare("SELECT rating FROM tracks WHERE title = ?")
    .get(title) as { rating: number | null } | undefined;
  return row ? row.rating : null;
}

describe("ratingFromCommonTags — normalizing a file's rating tag (issue #118)", () => {
  it("scales music-metadata's 0..1 rating to the 0-10 half-star scale", () => {
    expect(ratingFromCommonTags({ rating: [{ rating: 1 }] })).toBe(10);
    expect(ratingFromCommonTags({ rating: [{ rating: 0.5 }] })).toBe(5);
    expect(ratingFromCommonTags({ rating: [{ rating: 0 }] })).toBe(0);
  });

  it("takes the first entry that carries a numeric rating", () => {
    // A POPM frame with rating byte 0 comes back as `rating: undefined` (see
    // ID3v24TagMapper.toRating) — that entry must be skipped, not treated as 0.
    expect(
      ratingFromCommonTags({
        rating: [{ source: "no@opinion" }, { rating: 0.8 }],
      })
    ).toBe(8);
  });

  it("returns null when the file carries no rating tag at all", () => {
    expect(ratingFromCommonTags({})).toBeNull();
    expect(ratingFromCommonTags({ rating: [] })).toBeNull();
    expect(ratingFromCommonTags({ rating: [{ source: "x" }] })).toBeNull();
  });

  it("clamps a malformed out-of-range value instead of writing outside the CHECK constraint", () => {
    expect(ratingFromCommonTags({ rating: [{ rating: 5 }] })).toBe(10);
    expect(ratingFromCommonTags({ rating: [{ rating: -3 }] })).toBe(0);
  });
});

describe("Library scan — seeding ratings from file tags (issue #118)", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("rating-tag-");
    libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    if (canRunDbTests) db = createTestDb();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("seeds tracks.rating from a fresh import's tag", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Rated.flac",
      metadata: {
        title: "Rated",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
        rating: 1, // e.g. a Vorbis `RATING=100` comment
      },
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Unrated.flac",
      metadata: {
        title: "Unrated",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
      },
    });

    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(trackRating(db, "Rated")).toBe(10);
    expect(trackRating(db, "Unrated")).toBeNull();
  });

  itDb("never overwrites a rating that already came from the device or the app", async () => {
    const filePath = seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Track.flac",
      metadata: {
        title: "Track",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
      },
    });

    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(trackRating(db, "Track")).toBeNull();

    // A device sync (or an in-app edit) rates the track — this must become
    // the one source of truth from here on, exactly like mergeRating()
    // guarantees for the device/app pair.
    db.prepare("UPDATE tracks SET rating = 6 WHERE title = 'Track'").run();

    // The file's own tag now disagrees — e.g. the library manager wrote its
    // own value on a later pass, or the mock is standing in for a Swinsian
    // edit the reporter made. Touch mtime so this file is not skipped.
    fs.writeFileSync(filePath, Buffer.from("changed-bytes"));
    resetMusicMetadataMock();
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Track.flac",
      metadata: {
        title: "Track",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
        rating: 0.2,
      },
      contents: Buffer.from("changed-bytes"),
    });

    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    // The canonical rating survives untouched — the tag never gets a second
    // say once something else has rated the track.
    expect(trackRating(db, "Track")).toBe(6);
  });

  itDb(
    "backfills a rating for a library scanned before issue #118, even though its mtime never changed",
    async () => {
      // Simulate a library iPodRocks already scanned before rating-tag support
      // existed: the track row and its content_hashes entry are exactly what a
      // prior scan would have left, but the file already carried a rating tag
      // that nothing ever read.
      const filePath = seedAudioFile({
        dir: libraryDir,
        relPath: "Artist/Album/Legacy.flac",
        metadata: {
          title: "Legacy",
          artist: "Artist",
          album: "Album",
          duration: 180,
          bitrate: 1000,
          codec: "FLAC",
          rating: 0.6,
        },
      });
      const folderId = seedLibraryFolder(db, { name: "L", path: libraryDir });
      seedTrack(db, {
        path: filePath,
        title: "Legacy",
        libraryFolderId: folderId,
        duration: 180,
        rating: null,
      });
      const mtimeMs = fs.statSync(filePath).mtimeMs;
      db.prepare(
        "INSERT INTO content_hashes (file_path, content_hash, metadata_hash, file_size, last_modified, hash_type, updated_at) VALUES (?, 'h', 'm', 100, ?, 'sha256', datetime('now'))"
      ).run(filePath, new Date(mtimeMs).toISOString());

      const scanner = new LibraryScanner(db);
      const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
        scanHarmonicData: false,
      });

      // The regular per-file loop skips it — mtime is unchanged — so the
      // rating can only have come from the one-shot backfill at the top of
      // scanFolder().
      expect(result.filesAdded).toBe(0);
      expect(trackRating(db, "Legacy")).toBe(6);
    }
  );

  itDb("the rating-tag backfill runs once and does not re-check already-seen tracks", async () => {
    const filePath = seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Legacy.flac",
      metadata: {
        title: "Legacy",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
        rating: 0.6,
      },
    });
    const folderId = seedLibraryFolder(db, { name: "L", path: libraryDir });
    seedTrack(db, {
      path: filePath,
      title: "Legacy",
      libraryFolderId: folderId,
      duration: 180,
      rating: null,
    });
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    db.prepare(
      "INSERT INTO content_hashes (file_path, content_hash, metadata_hash, file_size, last_modified, hash_type, updated_at) VALUES (?, 'h', 'm', 100, ?, 'sha256', datetime('now'))"
    ).run(filePath, new Date(mtimeMs).toISOString());

    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(trackRating(db, "Legacy")).toBe(6);
    expect(isRatingTagBackfillDone(db)).toBe(true);

    // A device sync (or the user, in-app) rates it differently after the
    // backfill seeded it.
    db.prepare("UPDATE tracks SET rating = 9 WHERE title = 'Legacy'").run();

    // The sentinel must stop the backfill from ever re-reading this file's
    // tag again, even on a later scan.
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(trackRating(db, "Legacy")).toBe(9);
  });
});
