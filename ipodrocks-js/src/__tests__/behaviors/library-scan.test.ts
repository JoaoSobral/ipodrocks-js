/**
 * @vitest-environment node
 *
 * Behavioral journeys for the library — scanning a folder, re-scanning after
 * filesystem changes, and propagating removals through the shadow library.
 *
 * Drives the `LibraryScanner` and `ShadowLibraryManager` directly (the same
 * objects the IPC handlers in `src/main/ipc/` use).
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
  seedTrack,
  seedLibraryFolder,
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
    expect(second.removedTrackIds?.length).toBe(1);

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

  itDb("keeps distinct tracks that share artist/album/title across discs", async () => {
    // Multi-disc album with a same-titled track on each disc (e.g. "Intro").
    // The album is disc-agnostic, so both tracks share artist_id + album_id +
    // title — the exact collision the old dedup collapsed. Distinct contents
    // give distinct hashes so this is NOT flagged as a byte-identical copy.
    seedAudioFile({
      dir: libraryDir,
      relPath: "Band/Anthology/CD1/01 - Intro.flac",
      metadata: { title: "Intro", artist: "Band", album: "Anthology", discNumber: 1, trackNumber: 1, duration: 60, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("disc-one-intro"),
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Band/Anthology/CD2/01 - Intro.flac",
      metadata: { title: "Intro", artist: "Band", album: "Anthology", discNumber: 2, trackNumber: 1, duration: 62, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("disc-two-intro"),
    });

    const scanner = new LibraryScanner(db);
    const first = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(first.filesAdded).toBe(2);
    expect(first.duplicateFilesDetected ?? 0).toBe(0);
    expect(first.warnings ?? []).toHaveLength(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(2);

    // Re-scan must not delete either track (guards the removed post-scan cull).
    const second = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(second.filesRemoved ?? 0).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(2);
  });

  itDb("keeps distinct same-title tracks that differ only by track number", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Composer/Symphony/01 - Movement.flac",
      metadata: { title: "Movement", artist: "Composer", album: "Symphony", trackNumber: 1, duration: 300, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("movement-one"),
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Composer/Symphony/02 - Movement.flac",
      metadata: { title: "Movement", artist: "Composer", album: "Symphony", trackNumber: 2, duration: 320, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("movement-two"),
    });

    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, { scanHarmonicData: false });
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, { scanHarmonicData: false });

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(2);
  });

  itDb("keeps byte-identical duplicate files but reports them as a warning", async () => {
    const bytes = Buffer.from("identical-audio-bytes");
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/track.flac",
      metadata: { title: "Song", artist: "Artist", album: "Album", trackNumber: 1, duration: 180, bitrate: 1000, codec: "FLAC" },
      contents: bytes,
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/track-copy.flac",
      metadata: { title: "Song", artist: "Artist", album: "Album", trackNumber: 1, duration: 180, bitrate: 1000, codec: "FLAC" },
      contents: bytes,
    });

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(2);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(2);
    expect(result.duplicateFilesDetected).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("track.flac");
    expect(result.warnings?.[0]).toContain("track-copy.flac");
  });

  itDb("excludes trash/recycle-bin folders from scanning", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Daniel Caesar/Case Study 01/01 - Entropy.m4a",
      metadata: { title: "Entropy", artist: "Daniel Caesar", album: "Case Study 01", trackNumber: 1, duration: 240, bitrate: 256, codec: "AAC" },
      contents: Buffer.from("real-entropy"),
    });
    // Deleted copies inside trash folders must not be indexed as real tracks.
    seedAudioFile({
      dir: libraryDir,
      relPath: ".Trash-1000/files/Case Study 01/01 - Entropy.m4a",
      metadata: { title: "Entropy", artist: "Daniel Caesar", album: "Case Study 01", trackNumber: 1, duration: 240, bitrate: 256, codec: "AAC" },
      contents: Buffer.from("trashed-entropy"),
    });
    seedAudioFile({
      dir: libraryDir,
      relPath: ".Trashes/501/Entropy.m4a",
      metadata: { title: "Entropy", artist: "Daniel Caesar", album: "Case Study 01", trackNumber: 1, duration: 240, bitrate: 256, codec: "AAC" },
      contents: Buffer.from("mac-trashed-entropy"),
    });

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(1);
    expect(result.filesProcessed).toBe(1);
    const rows = db.prepare("SELECT path FROM tracks").all() as { path: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).not.toContain("Trash");
  });

  itDb("removes an existing track row that lives in a trash folder on re-scan", async () => {
    const folderId = Number(
      db
        .prepare("INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)")
        .run("L", libraryDir, "music").lastInsertRowid
    );
    // Pre-existing stale row pointing into a trash folder (from before this fix).
    const trashPath = path.join(libraryDir, ".Trash-1000/files/Song.flac");
    fs.mkdirSync(path.dirname(trashPath), { recursive: true });
    fs.writeFileSync(trashPath, Buffer.from("stale"));
    db.prepare(
      "INSERT INTO tracks (path, filename, content_type, library_folder_id) VALUES (?, ?, 'music', ?)"
    ).run(trashPath, "Song.flac", folderId);

    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Keep.flac",
      metadata: { title: "Keep", artist: "Artist", album: "Album", duration: 100, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("keep-me"),
    });

    const scanner = new LibraryScanner(db);
    await scanner.scanFolder(libraryDir, "music", undefined, undefined, { scanHarmonicData: false });

    const paths = (db.prepare("SELECT path FROM tracks").all() as { path: string }[]).map((r) => r.path);
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toContain("Trash");
  });

  itDb("scans legitimate folders whose name merely contains 'Trash'", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: "Trash Talk/No Peace/01 - The Hburg.mp3",
      metadata: { title: "The Hburg", artist: "Trash Talk", album: "No Peace", trackNumber: 1, duration: 120, bitrate: 320, codec: "MP3" },
      contents: Buffer.from("trash-talk"),
    });

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(1);
    const rows = db.prepare("SELECT path FROM tracks").all() as { path: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toContain("Trash Talk");
  });

  itDb("re-adds a track that exists on disk but is missing from the library (recovery)", async () => {
    // Simulates a user affected by the old dedup bug: file present on disk, but
    // no track row and no content_hashes entry. A normal scan must restore it.
    seedAudioFile({
      dir: libraryDir,
      relPath: "Artist/Album/Lost.flac",
      metadata: { title: "Lost", artist: "Artist", album: "Album", trackNumber: 3, duration: 200, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("recover-me"),
    });

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM content_hashes").get() as { n: number }).n
    ).toBe(0);

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    expect(result.filesAdded).toBe(1);
    const rows = db.prepare("SELECT title FROM tracks").all() as { title: string }[];
    expect(rows.map((r) => r.title)).toEqual(["Lost"]);
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

describe("Library — Unicode (NFC/NFD) path drift on SMB mounts", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;

  // "Café Album/01 Song.flac" spelled with explicit escapes so the on-disk
  // (NFD) and DB (NFC) forms are genuinely different byte sequences.
  const NFD_REL = "Cafe\u0301 Album/01 Song.flac"; // e + combining acute
  const NFC_REL = "Caf\u00e9 Album/01 Song.flac"; // precomposed é

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("lib-nfc-");
    libraryDir = path.join(tmpDir, "library");
    fs.mkdirSync(libraryDir, { recursive: true });
    if (canRunDbTests) db = createTestDb();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  function seedNfdFileWithNfcDbRows(): { rawPath: string; nfcPath: string } {
    // File on disk carries the NFD name (what an SMB/macOS mount can present).
    const rawPath = seedAudioFile({
      dir: libraryDir,
      relPath: NFD_REL,
      metadata: { title: "Song", artist: "Café", album: "Café Album", duration: 200, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("unicode-track"),
    });
    const nfcPath = path.join(libraryDir, NFC_REL);
    const mtimeMs = fs.statSync(rawPath).mtimeMs;

    // Pre-existing DB rows store the NFC form (as a prior scan would have).
    const folderId = seedLibraryFolder(db, { name: "library", path: libraryDir });
    seedTrack(db, { path: nfcPath, title: "Song", libraryFolderId: folderId, duration: 200 });
    db.prepare(
      "INSERT INTO content_hashes (file_path, content_hash, metadata_hash, file_size, last_modified, hash_type, updated_at) VALUES (?, 'h', 'm', 13, ?, 'sha256', datetime('now'))"
    ).run(nfcPath, new Date(mtimeMs).toISOString());

    return { rawPath, nfcPath };
  }

  itDb("does not churn when the on-disk name is NFD but the DB stores NFC", async () => {
    const { nfcPath } = seedNfdFileWithNfcDbRows();

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });

    // The mtime fast-skip fires across the normalization boundary: nothing
    // added, nothing removed, and exactly one (NFC) row remains.
    expect(result.filesAdded).toBe(0);
    expect(result.filesRemoved ?? 0).toBe(0);
    const rows = db.prepare("SELECT path FROM tracks").all() as { path: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe(nfcPath);
  });

  itDb("stores NFC and reads metadata when freshly scanning an NFD-named file", async () => {
    seedAudioFile({
      dir: libraryDir,
      relPath: NFD_REL,
      metadata: { title: "Song", artist: "Café", album: "Café Album", duration: 200, bitrate: 1000, codec: "FLAC" },
      contents: Buffer.from("fresh-unicode"),
    });

    const scanner = new LibraryScanner(db);
    const first = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(first.filesAdded).toBe(1);

    const row = db.prepare("SELECT path, title FROM tracks").get() as { path: string; title: string };
    expect(row.path).toBe(path.join(libraryDir, NFC_REL));
    expect(row.path.normalize("NFC")).toBe(row.path);
    expect(row.title).toBe("Song"); // proves the raw NFD path reached parseFile

    // Second scan must be a no-op — the perpetual-rescan symptom is gone.
    const second = await scanner.scanFolder(libraryDir, "music", undefined, undefined, {
      scanHarmonicData: false,
    });
    expect(second.filesAdded).toBe(0);
    expect(second.filesRemoved ?? 0).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tracks").get() as { n: number }).n).toBe(1);
  });
});
