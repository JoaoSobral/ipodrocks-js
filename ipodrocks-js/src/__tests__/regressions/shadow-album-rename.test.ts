/**
 * @vitest-environment node
 *
 * Shadow library must not keep a stale copy of a renamed album.
 *
 * Reported: the primary library is managed by Swinsian; renaming an album there
 * renames the folder on disk. iPodRocks picks that up on the next scan, but the
 * shadow (MPC) library keeps the old transcodes, so the same album accumulates
 * under several different names.
 *
 * Root cause: `LibraryScanner.deleteRemovedTracks()` deletes the `shadow_tracks`
 * ROW (by hand, inside its `foreign_keys = OFF` transaction) before the scan's
 * shadow propagation runs. `propagateRemovedByIds()` then looks the row up to
 * find `shadow_path`, finds nothing, and skips — so the transcoded file at the
 * OLD path is never unlinked. See the CLAUDE.md hazard note on that function.
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
import { LibraryScanner } from "../../main/library/library-scanner";

const itDb = it.skipIf(!canRunDbTests);

describe("Shadow library — album renamed in the primary library", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;
  let shadowDir: string;
  let folderId: number;
  let shadow: ShadowLibraryManager;
  let shadowLibId: number;

  const OLD_REL = path.join("Artist", "Old Album Name", "01 - Song.flac");
  const NEW_REL = path.join("Artist", "New Album Name", "01 - Song.flac");

  function mpcFor(rel: string): string {
    return path.join(shadowDir, rel.replace(/\.flac$/, ".mpc"));
  }

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("shadow-rename-");
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

    // The album as it exists before the rename: source file, track row, and a
    // synced shadow transcode.
    const src = path.join(libraryDir, OLD_REL);
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "source-audio");
    const trackId = seedTrack(db, {
      path: src,
      title: "Song",
      album: "Old Album Name",
      artist: "Artist",
      libraryFolderId: folderId,
      duration: 180,
      bitrate: 900_000,
      fileSize: 12,
    });

    const shadowFile = mpcFor(OLD_REL);
    fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
    fs.writeFileSync(shadowFile, "transcoded-audio");
    const st = fs.statSync(shadowFile);
    db.prepare(
      `INSERT INTO shadow_tracks
         (shadow_library_id, source_track_id, shadow_path, status, file_size, mtime)
       VALUES (?, ?, ?, 'synced', ?, ?)`
    ).run(shadowLibId, trackId, shadowFile, st.size, Math.floor(st.mtimeMs));
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("removes the shadow transcode that belonged to the old album name", async () => {
    // Rename the album folder the way Swinsian would.
    fs.renameSync(
      path.join(libraryDir, "Artist", "Old Album Name"),
      path.join(libraryDir, "Artist", "New Album Name")
    );

    expect(fs.existsSync(mpcFor(OLD_REL))).toBe(true);

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music");

    // The scan sees the rename as a removal plus an addition.
    expect(result.removedTrackIds?.length).toBe(1);

    // Propagate exactly as the library:scan IPC handler does.
    shadow.propagateRemovedByIds(result.removedTrackIds ?? []);
    shadow.deleteOrphanedShadowFiles(result.removedShadowPaths ?? []);

    // The stale transcode under the OLD album name must be gone, or the shadow
    // library ends up with two copies of the same album.
    expect(fs.existsSync(mpcFor(OLD_REL))).toBe(false);

    // And no shadow_tracks row should still point at it.
    const rows = db
      .prepare("SELECT shadow_path FROM shadow_tracks WHERE shadow_library_id = ?")
      .all(shadowLibId) as { shadow_path: string }[];
    expect(rows.map((r) => r.shadow_path)).not.toContain(mpcFor(OLD_REL));
  });

  itDb("also cleans up when a track is deleted outright, not just renamed", async () => {
    fs.rmSync(path.join(libraryDir, "Artist", "Old Album Name"), {
      recursive: true,
      force: true,
    });

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music");
    shadow.propagateRemovedByIds(result.removedTrackIds ?? []);
    shadow.deleteOrphanedShadowFiles(result.removedShadowPaths ?? []);

    expect(fs.existsSync(mpcFor(OLD_REL))).toBe(false);
  });

  itDb("refuses to delete a path outside any shadow-library root", () => {
    const outside = path.join(tmpDir, "not-a-shadow.mpc");
    fs.writeFileSync(outside, "precious");

    const deleted = shadow.deleteOrphanedShadowFiles([outside]);

    expect(deleted).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });

  itDb("keeps the shadow library root itself even when it empties", () => {
    shadow.deleteOrphanedShadowFiles([mpcFor(OLD_REL)]);

    expect(fs.existsSync(mpcFor(OLD_REL))).toBe(false);
    expect(fs.existsSync(shadowDir)).toBe(true);
  });

  itDb("leaves no empty album directory behind in the shadow library", async () => {
    fs.renameSync(
      path.join(libraryDir, "Artist", "Old Album Name"),
      path.join(libraryDir, "Artist", "New Album Name")
    );

    const scanner = new LibraryScanner(db);
    const result = await scanner.scanFolder(libraryDir, "music");
    shadow.propagateRemovedByIds(result.removedTrackIds ?? []);
    shadow.deleteOrphanedShadowFiles(result.removedShadowPaths ?? []);

    expect(fs.existsSync(path.join(shadowDir, "Artist", "Old Album Name"))).toBe(false);
  });
});
