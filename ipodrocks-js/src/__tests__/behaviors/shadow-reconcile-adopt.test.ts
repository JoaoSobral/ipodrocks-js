/**
 * Behavior test — shadow library reconciliation pass.
 *
 * Drives `ShadowLibraryManager.reconcileShadowLibrary` directly against an
 * in-memory DB, so the classification matrix is exercised without running a
 * single encode. Covers the recovery case the feature exists for (the DB row
 * was lost but the transcoded files are intact) plus the destructive edges:
 * an unreachable root must not be mistaken for "every file is gone".
 *
 * NOTE: every registerFixture below sets BOTH duration and bitrate. Omitting
 * either sends `extractAudioInfo` down its `if (!duration || !bitrate)` branch,
 * which spawns ffprobe against the placeholder file — slow and host-dependent.
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
  registerFixture,
  resetMusicMetadataMock,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

installMusicMetadataMock();

import { ShadowLibraryManager } from "../../main/library/shadow-library";
import type { Track } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

const TRACK_SECONDS = 180;

describe("Shadow library — reconcile / adopt existing files", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;
  let shadowDir: string;
  let folderId: number;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("shadow-reconcile-");
    libraryDir = path.join(tmpDir, "library");
    shadowDir = path.join(tmpDir, "shadow");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(shadowDir, { recursive: true });
    if (canRunDbTests) {
      db = createTestDb();
      folderId = seedLibraryFolder(db, { name: "Lib", path: libraryDir });
    }
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  /** An OPUS codec configuration — the shadow library's target. */
  function opusConfigId(): number {
    const row = db
      .prepare(
        `SELECT cc.id FROM codec_configurations cc
         JOIN codecs c ON cc.codec_id = c.id
         WHERE c.name = 'OPUS' ORDER BY cc.id LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) throw new Error("expected a seeded OPUS codec configuration");
    return row.id;
  }

  /** Seed a source track (and its file) in the primary library. */
  function seedSource(relPath: string): Track {
    const full = path.join(libraryDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "source");
    const id = seedTrack(db, {
      path: full,
      title: path.basename(relPath),
      libraryFolderId: folderId,
      duration: TRACK_SECONDS,
      bitrate: 900_000,
      fileSize: 6,
    });
    return {
      id,
      path: full,
      filename: path.basename(relPath),
      duration: TRACK_SECONDS,
      libraryFolderId: folderId,
    } as Track;
  }

  /**
   * Write a file where the shadow library would put this track, and register
   * what a probe of it should report.
   */
  function placeShadowFile(
    track: Track,
    opts: { codec?: string; bitrate?: number; duration?: number; body?: string } = {}
  ): string {
    const rel = path.relative(libraryDir, track.path).replace(/\.[^.]+$/, ".opus");
    const dest = path.join(shadowDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, opts.body ?? "shadow-audio-bytes");
    registerFixture(dest, {
      codec: opts.codec ?? "Opus",
      bitrate: opts.bitrate ?? 128_000,
      duration: opts.duration ?? TRACK_SECONDS,
    });
    return dest;
  }

  function folderMap(): Map<number, string> {
    return new Map([[folderId, libraryDir]]);
  }

  function shadowRows(libId: number) {
    return db
      .prepare("SELECT * FROM shadow_tracks WHERE shadow_library_id = ?")
      .all(libId) as {
      id: number;
      source_track_id: number;
      shadow_path: string;
      status: string;
      file_size: number | null;
      mtime: number | null;
    }[];
  }

  itDb("adopts a correctly-encoded file that has no DB row", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    const dest = placeShadowFile(track);

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.adopted).toBe(1);
    expect(res.rejected).toBe(0);
    expect(res.probed).toBe(1);

    const rows = shadowRows(libId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("synced");
    expect(rows[0].shadow_path).toBe(dest);
    expect(rows[0].file_size).toBe(fs.statSync(dest).size);
    expect(rows[0].mtime).not.toBeNull();
  });

  itDb("rejects a wrong-codec file and leaves it on disk", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    const dest = placeShadowFile(track, { codec: "MPEG 1 Layer 3" });

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.adopted).toBe(0);
    expect(res.rejected).toBe(1);
    expect(shadowRows(libId)).toHaveLength(0);
    // The encoder overwrites it later; reconcile must not delete user data.
    expect(fs.existsSync(dest)).toBe(true);
  });

  itDb("rejects a truncated file even when the codec matches", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    placeShadowFile(track, { duration: 9 });

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.adopted).toBe(0);
    expect(res.rejected).toBe(1);
  });

  itDb("drops a row whose file has vanished", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    const dest = placeShadowFile(track);

    await mgr.reconcileShadowLibrary(libId, [track], folderMap());
    expect(shadowRows(libId)).toHaveLength(1);

    fs.rmSync(dest);
    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.dropped).toBe(1);
    expect(shadowRows(libId)).toHaveLength(0);
  });

  itDb("leaves stray files alone", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    placeShadowFile(track);

    const stray = path.join(shadowDir, "Artist", "Album", "not-in-library.opus");
    fs.writeFileSync(stray, "stray");

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.adopted).toBe(1);
    expect(fs.existsSync(stray)).toBe(true);
    expect(shadowRows(libId)).toHaveLength(1);
  });

  itDb("trusts an unchanged row without re-probing", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    placeShadowFile(track);

    await mgr.reconcileShadowLibrary(libId, [track], folderMap());
    const second = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(second.verified).toBe(1);
    expect(second.adopted).toBe(0);
    // The strongest form of the assertion: the file was never opened.
    expect(second.probed).toBe(0);
  });

  itDb("backfills a legacy row with NULL stat without probing", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    const dest = placeShadowFile(track);

    // A row as it would look before the stat columns existed.
    db.prepare(
      `INSERT INTO shadow_tracks (shadow_library_id, source_track_id, shadow_path, status)
       VALUES (?, ?, ?, 'synced')`
    ).run(libId, track.id, dest);

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.backfilled).toBe(1);
    expect(res.probed).toBe(0);
    const row = shadowRows(libId)[0];
    expect(row.file_size).toBe(fs.statSync(dest).size);
    expect(row.mtime).not.toBeNull();
  });

  itDb("re-probes a row whose file changed underneath it", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    const dest = placeShadowFile(track);

    await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    // Same path, different contents — stat no longer matches the stored row.
    fs.writeFileSync(dest, "shadow-audio-bytes-but-longer");
    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.probed).toBe(1);
    expect(res.verified).toBe(1);
    expect(shadowRows(libId)[0].file_size).toBe(fs.statSync(dest).size);
  });

  itDb("stops on an aborted signal without mutating rows", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    placeShadowFile(track);

    const controller = new AbortController();
    controller.abort();

    const res = await mgr.reconcileShadowLibrary(
      libId,
      [track],
      folderMap(),
      undefined,
      controller.signal
    );

    expect(res.cancelled).toBe(true);
    expect(res.adopted).toBe(0);
    expect(shadowRows(libId)).toHaveLength(0);
  });

  // The destructive edge: building a library that lives on an unmounted drive
  // must not read as "every file is gone" and delete the whole row set.
  itDb("skips entirely when the shadow root is unreachable", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());
    const track = seedSource("Artist/Album/song.flac");
    placeShadowFile(track);

    await mgr.reconcileShadowLibrary(libId, [track], folderMap());
    expect(shadowRows(libId)).toHaveLength(1);

    fs.rmSync(shadowDir, { recursive: true, force: true });
    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.skipped).toBe(true);
    expect(res.dropped).toBe(0);
    expect(shadowRows(libId)).toHaveLength(1);
  });

  itDb("matches a stored NFC row against an NFD file on disk", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());

    // "café" composed (NFC) in the DB, decomposed (NFD) on disk.
    const track = seedSource("Artist/Album/café.flac");
    const nfcDest = path.join(shadowDir, "Artist", "Album", "café.opus");
    const nfdDest = nfcDest.normalize("NFD");

    fs.mkdirSync(path.dirname(nfdDest), { recursive: true });
    fs.writeFileSync(nfdDest, "shadow-audio-bytes");
    registerFixture(nfdDest, {
      codec: "Opus",
      bitrate: 128_000,
      duration: TRACK_SECONDS,
    });
    registerFixture(nfcDest, {
      codec: "Opus",
      bitrate: 128_000,
      duration: TRACK_SECONDS,
    });

    const res = await mgr.reconcileShadowLibrary(libId, [track], folderMap());

    expect(res.dropped).toBe(0);
    expect(res.adopted).toBe(1);
  });

  itDb("only re-encodes the tracks that did not match", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("Opus", shadowDir, opusConfigId());

    const good = seedSource("Artist/Album/one.flac");
    const bad = seedSource("Artist/Album/two.flac");
    const absent = seedSource("Artist/Album/three.flac");

    placeShadowFile(good);
    placeShadowFile(bad, { codec: "MPEG 1 Layer 3" });
    // `absent` gets no shadow file at all.

    const res = await mgr.reconcileShadowLibrary(
      libId,
      [good, bad, absent],
      folderMap()
    );

    expect(res.adopted).toBe(1);
    expect(res.rejected).toBe(1);

    // Only the verified track is marked synced, so only it is skipped later.
    const rows = shadowRows(libId);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_track_id).toBe(good.id);
  });
});
