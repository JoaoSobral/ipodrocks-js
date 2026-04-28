/**
 * @vitest-environment node
 *
 * Regression test for ENTROPY/entropy duplicate: same track (artist, album, title)
 * at two paths (main library vs Trash) should deduplicate to one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { SCHEMA_SQL } from "../main/database/schema";
import { LibraryScanner } from "../main/library/library-scanner";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node */
}

describe("ENTROPY deduplication", () => {
  let db: import("better-sqlite3").Database | null;
  let tmpDir: string;
  let musicRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entropy-test-"));
    musicRoot = path.join(tmpDir, "music");
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
    "skips duplicate ENTROPY from Trash when main library version exists",
    async () => {
      const mainPath = path.join(
        musicRoot,
        "Daniel Caesar",
        "Case Study 01",
        "01 - Entropy.m4a"
      );
      const trashPath = path.join(
        musicRoot,
        ".Trash-1000",
        "files",
        "CASE STUDY 01",
        "01 - ENTROPY.m4a"
      );

      fs.mkdirSync(path.dirname(mainPath), { recursive: true });
      fs.mkdirSync(path.dirname(trashPath), { recursive: true });
      fs.writeFileSync(mainPath, "main");
      fs.writeFileSync(trashPath, "trash");

      db!.exec(`
        INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', '${musicRoot.replace(/'/g, "''")}', 'music');
        INSERT INTO artists (id, name) VALUES (442, 'Daniel Caesar');
        INSERT INTO albums (id, title, artist_id) VALUES (442, 'CASE STUDY 01', 442);
        INSERT INTO genres (id, name) VALUES (1, 'R&B');
        INSERT INTO codecs (id, name) VALUES (1, 'AAC');
      `);

      const scanner = new LibraryScanner(db!);
      const result = await scanner.scanFolder(
        musicRoot,
        "music",
        undefined,
        undefined,
        { scanHarmonicData: false }
      );

      const entropyTracks = db!.prepare(`
        SELECT id, path, title FROM tracks
        WHERE LOWER(title) = 'entropy'
        ORDER BY id
      `).all() as { id: number; path: string; title: string }[];

      expect(entropyTracks).toHaveLength(1);
      expect(entropyTracks[0].path).toBe(mainPath);
      expect(entropyTracks[0].title).toBe("Entropy");
    }
  );

  it.skipIf(!canRunDbTests)(
    "deduplicates when Trash is scanned first (keeps lower-id = first added)",
    async () => {
      db!.exec(`
        INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', '${musicRoot.replace(/'/g, "''")}', 'music');
        INSERT INTO artists (id, name) VALUES (442, 'Daniel Caesar');
        INSERT INTO albums (id, title, artist_id) VALUES (442, 'CASE STUDY 01', 442);
        INSERT INTO genres (id, name) VALUES (1, 'R&B');
        INSERT INTO codecs (id, name) VALUES (1, 'AAC');
        INSERT INTO tracks (id, path, filename, title, content_type, library_folder_id, artist_id, album_id, genre_id, codec_id)
          VALUES (444, '${path.join(musicRoot, "Daniel Caesar/Case Study 01/01 - Entropy.m4a").replace(/'/g, "''")}', '01 - Entropy.m4a', 'Entropy', 'music', 1, 442, 442, 1, 1),
                 (2808, '${path.join(musicRoot, ".Trash-1000/files/CASE STUDY 01/01 - ENTROPY.m4a").replace(/'/g, "''")}', '01 - ENTROPY.m4a', 'ENTROPY', 'music', 1, 442, 442, 1, 1);
      `);

      const emptyDir = path.join(tmpDir, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });

      db!.exec(`UPDATE library_folders SET path = '${emptyDir.replace(/'/g, "''")}' WHERE id = 1`);

      const scanner = new LibraryScanner(db!);
      await scanner.scanFolder(
        emptyDir,
        "music",
        undefined,
        undefined,
        { scanHarmonicData: false }
      );

      const entropyTracks = db!.prepare(`
        SELECT id, path, title FROM tracks
        WHERE LOWER(title) = 'entropy'
        ORDER BY id
      `).all() as { id: number; path: string; title: string }[];

      expect(entropyTracks).toHaveLength(1);
      expect(entropyTracks[0].id).toBe(444);
      expect(entropyTracks[0].path).toContain("Daniel Caesar");
      expect(entropyTracks[0].path).not.toContain("Trash");
    }
  );
});
