/**
 * @vitest-environment node
 *
 * Shadow-library orphan prune, driven against a real DB and a real tmp tree.
 *
 * A shadow library is a faithful copy of the main library in another codec, so
 * a file with no `shadow_tracks` row is dead weight. Older versions left those
 * behind whenever an album was renamed or deleted; this is the one-shot
 * cleanup for that backlog.
 *
 * The destructive edges matter more than the happy path here: an unreachable
 * root must not be read as "everything is an orphan", live albums must keep
 * their artwork, and nothing outside the library root may ever be touched.
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
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

installMusicMetadataMock();

import { ShadowLibraryManager } from "../../main/library/shadow-library";

const itDb = it.skipIf(!canRunDbTests);

describe("Shadow library — prune orphan files", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;
  let shadowDir: string;
  let folderId: number;
  let shadow: ShadowLibraryManager;
  let shadowLibId: number;

  /** Write a shadow file and, optionally, the row that claims it. */
  function putShadowFile(rel: string, claimed: boolean, bytes = "audio"): string {
    const full = path.join(shadowDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);

    if (claimed) {
      const srcRel = rel.replace(/\.mpc$/, ".flac");
      const src = path.join(libraryDir, srcRel);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, "source");
      const trackId = seedTrack(db, {
        path: src,
        title: path.basename(srcRel),
        libraryFolderId: folderId,
        duration: 180,
        bitrate: 900_000,
        fileSize: 6,
      });
      const st = fs.statSync(full);
      db.prepare(
        `INSERT INTO shadow_tracks
           (shadow_library_id, source_track_id, shadow_path, status, file_size, mtime)
         VALUES (?, ?, ?, 'synced', ?, ?)`
      ).run(shadowLibId, trackId, full, st.size, Math.floor(st.mtimeMs));
    }
    return full;
  }

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("shadow-prune-");
    libraryDir = path.join(tmpDir, "library");
    shadowDir = path.join(tmpDir, "shadow");
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(shadowDir, { recursive: true });
    if (!canRunDbTests) return;

    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "Lib", path: libraryDir });
    shadow = new ShadowLibraryManager(db);

    const codecConfigId = (
      db
        .prepare(
          `SELECT cc.id FROM codec_configurations cc
           JOIN codecs c ON cc.codec_id = c.id
           WHERE c.name = 'MPC' ORDER BY cc.id LIMIT 1`
        )
        .get() as { id: number }
    ).id;
    shadowLibId = shadow.createShadowLibrary("MPC", shadowDir, codecConfigId);
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("removes a leftover album and keeps the one the library still has", () => {
    const live = putShadowFile("Artist/Peter/01.mpc", true);
    const stale = putShadowFile("Artist/Donald/01.mpc", false);

    const result = shadow.pruneOrphanedFiles(shadowLibId);

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  itDb("removes the emptied album folder too", () => {
    putShadowFile("Artist/Peter/01.mpc", true);
    putShadowFile("Artist/Donald/01.mpc", false);

    shadow.pruneOrphanedFiles(shadowLibId);

    expect(fs.existsSync(path.join(shadowDir, "Artist", "Donald"))).toBe(false);
    expect(fs.existsSync(path.join(shadowDir, "Artist", "Peter"))).toBe(true);
  });

  itDb("keeps artwork for a live album and drops it for a dead one", () => {
    putShadowFile("Artist/Peter/01.mpc", true);
    const liveCover = path.join(shadowDir, "Artist/Peter/cover.jpg");
    fs.writeFileSync(liveCover, "art");

    putShadowFile("Artist/Donald/01.mpc", false);
    const deadCover = path.join(shadowDir, "Artist/Donald/cover.jpg");
    fs.writeFileSync(deadCover, "art");

    shadow.pruneOrphanedFiles(shadowLibId);

    expect(fs.existsSync(liveCover)).toBe(true);
    expect(fs.existsSync(deadCover)).toBe(false);
  });

  itDb("is a no-op when the shadow library is already faithful", () => {
    const a = putShadowFile("Artist/Album/01.mpc", true);
    const b = putShadowFile("Artist/Album/02.mpc", true);

    const result = shadow.pruneOrphanedFiles(shadowLibId);

    expect(result.deleted).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  itDb("is idempotent — a second run finds nothing left to do", () => {
    putShadowFile("Artist/Peter/01.mpc", true);
    putShadowFile("Artist/Donald/01.mpc", false);

    expect(shadow.pruneOrphanedFiles(shadowLibId).deleted).toBe(1);
    expect(shadow.pruneOrphanedFiles(shadowLibId).deleted).toBe(0);
  });

  itDb("reports the space it reclaimed", () => {
    putShadowFile("Artist/Donald/01.mpc", false, "x".repeat(2048));

    const result = shadow.pruneOrphanedFiles(shadowLibId);
    expect(result.bytesFreed).toBe(2048);
  });

  itDb("refuses to run when the shadow folder is unreachable", () => {
    putShadowFile("Artist/Peter/01.mpc", true);
    fs.rmSync(shadowDir, { recursive: true, force: true });

    // An unplugged drive must never be mistaken for "every file is an orphan".
    expect(() => shadow.pruneOrphanedFiles(shadowLibId)).toThrow(/not reachable/i);
  });

  itDb("never touches files outside the shadow library root", () => {
    const outside = path.join(tmpDir, "outside.mpc");
    fs.writeFileSync(outside, "precious");
    putShadowFile("Artist/Donald/01.mpc", false);

    shadow.pruneOrphanedFiles(shadowLibId);

    expect(fs.existsSync(outside)).toBe(true);
  });

  itDb("keeps the shadow library root even when everything in it goes", () => {
    putShadowFile("Artist/Donald/01.mpc", false);

    shadow.pruneOrphanedFiles(shadowLibId);

    expect(fs.existsSync(shadowDir)).toBe(true);
  });

  itDb("rejects an unknown shadow library", () => {
    expect(() => shadow.pruneOrphanedFiles(99999)).toThrow(/not found/i);
  });
});
