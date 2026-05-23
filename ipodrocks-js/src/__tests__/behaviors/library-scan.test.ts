/**
 * @vitest-environment node
 *
 * Behavioral journeys for the library — scanning a folder, re-scanning after
 * filesystem changes, and propagating removals through the shadow library.
 *
 * Drives the `LibraryScanner` and `ShadowLibraryManager` directly (the same
 * objects the IPC handlers in `src/main/ipc.ts` use).
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
  type TestDb,
} from "../harness";

installMusicMetadataMock();

import { LibraryScanner } from "../../main/library/library-scanner";
import { LibraryCore } from "../../main/library/library-core";

const itDb = it.skipIf(!canRunDbTests);

describe("Library — scan journey", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("lib-scan-");
    libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    if (canRunDbTests) db = createTestDb();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("adds a folder, scans it, and populates tracks/albums/artists/genres", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist A/Album One/01 - First.flac",
      metadata: {
        title: "First",
        artist: "Artist A",
        album: "Album One",
        genre: "Rock",
        trackNumber: 1,
        duration: 180,
        bitrate: 1000,
        codec: "FLAC",
      },
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist A/Album One/02 - Second.flac",
      metadata: {
        title: "Second",
        artist: "Artist A",
        album: "Album One",
        genre: "Rock",
        trackNumber: 2,
        duration: 200,
        bitrate: 1000,
        codec: "FLAC",
      },
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist B/Album Two/01 - Other.mp3",
      metadata: {
        title: "Other",
        artist: "Artist B",
        album: "Album Two",
        genre: "Pop",
        trackNumber: 1,
        duration: 210,
        bitrate: 320,
        codec: "MP3",
      },
    });

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(3);
    expect(result.filesProcessed).toBe(3);

    const trackCount = db.prepare("SELECT COUNT(*) as n FROM tracks").get() as { n: number };
    expect(trackCount.n).toBe(3);

    const artists = db
      .prepare("SELECT name FROM artists ORDER BY name")
      .all() as { name: string }[];
    expect(artists.map((a) => a.name)).toEqual(["Artist A", "Artist B"]);

    const albums = db
      .prepare("SELECT title FROM albums ORDER BY title")
      .all() as { title: string }[];
    expect(albums.map((a) => a.title)).toEqual(["Album One", "Album Two"]);

    const genres = db
      .prepare("SELECT name FROM genres ORDER BY name")
      .all() as { name: string }[];
    expect(genres.map((g) => g.name)).toEqual(["Pop", "Rock"]);

    const folders = db
      .prepare("SELECT path, content_type FROM library_folders")
      .all() as { path: string; content_type: string }[];
    expect(folders).toHaveLength(1);
    expect(folders[0].content_type).toBe("music");
  });

  itDb("re-scan detects newly added and removed files", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "X/keep.flac",
      metadata: { title: "Keep", artist: "X", album: "Album X", duration: 120, bitrate: 1000 },
    });
    const removable = seedAudioFile({
      dir: libraryDir,
      relPath: "X/temp.flac",
      metadata: { title: "Temp", artist: "X", album: "Album X", duration: 90, bitrate: 1000 },
    });

    const scanner = new LibraryScanner(db);
    const first = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(first.filesAdded).toBe(2);

    fs.rmSync(removable);
    seedAudioFile({
      dir: libraryDir,
      relPath: "X/new.flac",
      metadata: { title: "New", artist: "X", album: "Album X", duration: 150, bitrate: 1000 },
    });

    const second = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(second.filesAdded).toBe(1);
    expect(second.filesRemoved).toBe(1);
    expect(second.removedTrackIds.length).toBe(1);

    const titles = (
      db.prepare("SELECT title FROM tracks ORDER BY title").all() as { title: string }[]
    ).map((r) => r.title);
    expect(titles).toEqual(["Keep", "New"]);
  });

  itDb("skips macOS AppleDouble (._) sidecar files when scanning (issue #77)", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/05 Mirage.ogg",
      metadata: {
        title: "Mirage",
        artist: "Artist",
        album: "Album",
        genre: "Rock",
        trackNumber: 5,
        duration: 240,
        bitrate: 192,
        codec: "OGG",
      },
    });
    // macOS-style sidecar with the same extension — must be ignored.
    fs.writeFileSync(
      path.join(libraryDir, "Artist/Album/._05 Mirage.ogg"),
      Buffer.alloc(82)
    );

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(1);
    expect(result.filesProcessed).toBe(1);

    const rows = db
      .prepare("SELECT path FROM tracks")
      .all() as { path: string }[];
    expect(rows).toHaveLength(1);
    expect(path.basename(rows[0].path)).toBe("05 Mirage.ogg");
  });

  itDb("purges pre-existing AppleDouble (._) track rows when LibraryCore initializes", () => {
    const folderId = Number(
      db
        .prepare(
          "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
        )
        .run("L", libraryDir, "music").lastInsertRowid
    );
    const insert = db.prepare(
      "INSERT INTO tracks (path, filename, content_type, library_folder_id) VALUES (?, ?, 'music', ?)"
    );
    insert.run(
      path.join(libraryDir, "Artist/Album/05 Mirage.ogg"),
      "05 Mirage.ogg",
      folderId
    );
    insert.run(
      path.join(libraryDir, "Artist/Album/._05 Mirage.ogg"),
      "._05 Mirage.ogg",
      folderId
    );
    insert.run(
      path.join(libraryDir, "Other/._hidden.mp3"),
      "._hidden.mp3",
      folderId
    );

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(3);

    // Constructing LibraryCore runs the one-time purge.
    new LibraryCore(db);

    const remaining = (
      db.prepare("SELECT filename FROM tracks ORDER BY filename").all() as {
        filename: string;
      }[]
    ).map((r) => r.filename);
    expect(remaining).toEqual(["05 Mirage.ogg"]);
  });
});
