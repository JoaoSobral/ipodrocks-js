/**
 * @vitest-environment node
 *
 * Integration tests for library scanner removal and shadow propagation.
 * Requires better-sqlite3 compiled for the current Node (run `npm run postinstall`
 * for Electron; tests use system Node and may skip if module version mismatches).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { SCHEMA_SQL } from "../main/database/schema";
import { LibraryScanner } from "../main/library/library-scanner";
import { ShadowLibraryManager } from "../main/library/shadow-library";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node; skip DB tests */
}

describe("library scanner and shadow propagation", () => {
  let db: import("better-sqlite3").Database | null;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-scanner-test-"));
    if (canRunDbTests) {
      const Database = require("better-sqlite3");
      db = new Database(":memory:") as import("better-sqlite3").Database;
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec(SCHEMA_SQL);
    } else {
      db = null;
    }
  });

  afterEach(() => {
    if (db) db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it.skipIf(!canRunDbTests)(
    "deleteRemovedTracks removes tracks and returns removedTrackIds for shadow propagation",
    async () => {
      const libraryPath = path.join(tmpDir, "library");
      const track1Path = path.join(libraryPath, "Artist", "Album", "track1.flac");
      const track2Path = path.join(libraryPath, "Artist", "Album", "track2.flac");

      db!.exec(`
      INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', '${libraryPath.replace(/'/g, "''")}', 'music');
      INSERT INTO artists (id, name) VALUES (1, 'Artist');
      INSERT INTO albums (id, title, artist_id) VALUES (1, 'Album', 1);
      INSERT INTO genres (id, name) VALUES (1, 'Rock');
      INSERT INTO codecs (id, name) VALUES (1, 'FLAC');
      INSERT INTO tracks (id, path, filename, title, content_type, library_folder_id, artist_id, album_id, genre_id, codec_id)
        VALUES (1, '${track1Path.replace(/'/g, "''")}', 'track1.flac', 'Track 1', 'music', 1, 1, 1, 1, 1),
               (2, '${track2Path.replace(/'/g, "''")}', 'track2.flac', 'Track 2', 'music', 1, 1, 1, 1, 1);
    `);

      fs.mkdirSync(path.join(libraryPath, "Artist", "Album"), { recursive: true });
      fs.writeFileSync(track1Path, "x");
      // track2.flac does NOT exist - so it will be "removed" when we scan

      const scanner = new LibraryScanner(db!);
      const result = await scanner.scanFolder(
        libraryPath,
        "music",
        undefined,
        undefined,
        { scanHarmonicData: false }
      );

      expect(result.filesRemoved).toBe(1);
      expect(result.removedTrackIds).toContain(2);

      const remaining = db!.prepare("SELECT id, path FROM tracks").all() as { id: number; path: string }[];
      expect(remaining).toHaveLength(1);
      expect(remaining[0].path).toBe(track1Path);
    }
  );

  it.skipIf(!canRunDbTests)(
    "propagateRemovedByIds removes shadow_tracks and deletes shadow files",
    () => {
      const shadowDir = path.join(tmpDir, "shadow");
      const shadowPath1 = path.join(shadowDir, "t1.opus");
      const shadowPath2 = path.join(shadowDir, "t2.opus");

      db!.exec(`
      INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', '/music', 'music');
      INSERT INTO artists (id, name) VALUES (1, 'Artist');
      INSERT INTO albums (id, title, artist_id) VALUES (1, 'Album', 1);
      INSERT INTO codecs (id, name) VALUES (1, 'FLAC');
      INSERT INTO codec_configurations (id, codec_id, name) VALUES (1, 1, 'Direct');
      INSERT INTO tracks (id, path, filename, title, content_type, artist_id, album_id, codec_id)
        VALUES (1, '/music/t1.flac', 't1.flac', 'T1', 'music', 1, 1, 1),
               (2, '/music/t2.flac', 't2.flac', 'T2', 'music', 1, 1, 1);
      INSERT INTO shadow_libraries (id, name, path, codec_config_id, status) VALUES (1, 'Shadow', '${shadowDir.replace(/'/g, "''")}', 1, 'ready');
      INSERT INTO shadow_tracks (shadow_library_id, source_track_id, shadow_path, status)
        VALUES (1, 1, '${shadowPath1.replace(/'/g, "''")}', 'synced'),
               (1, 2, '${shadowPath2.replace(/'/g, "''")}', 'synced');
    `);

      fs.mkdirSync(shadowDir, { recursive: true });
      fs.writeFileSync(shadowPath1, "x");
      fs.writeFileSync(shadowPath2, "y");

      const shadowManager = new ShadowLibraryManager(db!);
      shadowManager.propagateRemovedByIds([2]);

      const rows = db!.prepare("SELECT source_track_id FROM shadow_tracks").all() as { source_track_id: number }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].source_track_id).toBe(1);

      expect(fs.existsSync(shadowPath1)).toBe(true);
      expect(fs.existsSync(shadowPath2)).toBe(false);
    }
  );
});
