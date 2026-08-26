/**
 * @vitest-environment node
 *
 * Issue #118 follow-up — "Library tags always win" wired end-to-end through
 * `LibraryScanner.scanFolder({ forceRatingFromTags: true })`, the option the
 * `library:scan` IPC handler sets from `RatingPrefs.tagRatingAlwaysWins`
 * (off by default — see prefs.ts).
 *
 * `overwriteRatingsFromTags()` itself is pinned in isolation in
 * regressions/rating-tag-overwrite.test.ts. These tests confirm the option
 * actually reaches it from a real scan, and that leaving it off keeps the
 * default seed-only behavior from rating-tag-import.test.ts unchanged.
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
  seedDevice,
  type TestDb,
} from "../harness";

installMusicMetadataMock();

import { LibraryScanner } from "../../main/library/library-scanner";

const itDb = it.skipIf(!canRunDbTests);

function trackRating(db: TestDb, title: string): number | null {
  const row = db
    .prepare("SELECT rating FROM tracks WHERE title = ?")
    .get(title) as { rating: number | null } | undefined;
  return row ? row.rating : null;
}

describe("Library scan — 'library tags always win' toggle", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("rating-always-wins-");
    libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    if (canRunDbTests) db = createTestDb();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("off by default: a device-set rating survives a rescan even if the tag disagrees", async () => {
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
        rating: 0.2,
      },
    });
    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    db.prepare("UPDATE tracks SET rating = 9 WHERE title = 'Track'").run();

    fs.writeFileSync(filePath, Buffer.from("touch-mtime"));
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
      contents: Buffer.from("touch-mtime"),
    });
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
      // forceRatingFromTags omitted — must default to off.
    });

    expect(trackRating(db, "Track")).toBe(9);
  });

  itDb("on: overwrites a device-set rating from the tag, including clearing an untagged track", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Tagged.flac",
      metadata: {
        title: "Tagged",
        artist: "Artist",
        album: "Album",
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
        rating: 0.8,
      },
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Untagged.flac",
      metadata: {
        title: "Untagged",
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
    // Simulate prior device/in-app ratings this "clean slate" pass should override.
    db.prepare("UPDATE tracks SET rating = 3 WHERE title = 'Tagged'").run();
    db.prepare("UPDATE tracks SET rating = 7 WHERE title = 'Untagged'").run();

    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
      forceRatingFromTags: true,
    });

    expect(trackRating(db, "Tagged")).toBe(8);
    expect(trackRating(db, "Untagged")).toBeNull();
  });

  itDb("on: resolves an open rating conflict on a touched track as the library winning", async () => {
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
        rating: 1,
      },
    });
    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    const trackId = (
      db.prepare("SELECT id FROM tracks WHERE title = 'Track'").get() as { id: number }
    ).id;
    const deviceId = seedDevice(db, { name: "E2E iPod", mountPath: "/dev/null" });
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
       VALUES (?, ?, 4, 10, 10)`
    ).run(trackId, deviceId);

    await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
      forceRatingFromTags: true,
    });

    const conflict = db
      .prepare("SELECT resolved_at, resolution FROM rating_conflicts WHERE track_id = ?")
      .get(trackId) as { resolved_at: string | null; resolution: string | null };
    expect(conflict.resolved_at).not.toBeNull();
    expect(conflict.resolution).toBe("canonical_wins");
  });
});
