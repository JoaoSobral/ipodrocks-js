/**
 * @vitest-environment node
 *
 * Behavioral journey for the harmonic-data backfill — existing tracks without
 * key/BPM/Camelot get analysed and their features populated.
 *
 * Drives `LibraryScanner.backfillFeatures` (the same call the
 * `savant:backfillFeatures` IPC handler delegates to) with a music-metadata
 * mock that returns TKEY/BPM for some tracks but not others.
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

import { LibraryScanner } from "../../main/library/library-scanner";

const itDb = it.skipIf(!canRunDbTests);

describe("Library — harmonic backfill journey", () => {
  let db: TestDb;
  let tmpDir: string;

  beforeEach(() => {
    resetMusicMetadataMock();
    if (!canRunDbTests) return;
    db = createTestDb();
    tmpDir = createTmpDir("backfill-");
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  itDb("populates key/BPM/Camelot for tracks missing harmonic data", async () => {
    const folderId = seedLibraryFolder(db, { name: "Music", path: tmpDir, contentType: "music" });

    for (const rel of ["a.flac", "b.flac"]) {
      const full = path.join(tmpDir, rel);
      fs.writeFileSync(full, Buffer.alloc(50));
      seedTrack(db, { path: full, title: rel, artist: "X", album: "Y", libraryFolderId: folderId });
    }

    // Pre-condition: features_scanned = 0
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM tracks WHERE features_scanned = 0")
      .get() as { n: number };
    expect(before.n).toBe(2);

    const scanner = new LibraryScanner(db);
    const processed = await scanner.backfillFeatures(10);

    expect(processed).toBe(2);

    const after = db
      .prepare("SELECT COUNT(*) AS n FROM tracks WHERE features_scanned = 1")
      .get() as { n: number };
    expect(after.n).toBe(2);
  });

  itDb("respects maxTracks and stops after the requested number", async () => {
    const folderId = seedLibraryFolder(db, { name: "Music", path: tmpDir, contentType: "music" });

    for (let i = 0; i < 5; i++) {
      const full = path.join(tmpDir, `t${i}.flac`);
      fs.writeFileSync(full, Buffer.alloc(50));
      seedTrack(db, { path: full, title: `T${i}`, libraryFolderId: folderId });
    }

    const scanner = new LibraryScanner(db);
    const processed = await scanner.backfillFeatures(2);

    expect(processed).toBe(2);
    const scanned = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE features_scanned = 1").get() as { n: number };
    expect(scanned.n).toBe(2);
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM tracks WHERE features_scanned = 0").get() as { n: number };
    expect(remaining.n).toBe(3);
  });
});
