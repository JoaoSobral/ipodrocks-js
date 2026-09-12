/**
 * Regression — issue #130: a shadow library rebuild must check the tags on the
 * files it skips.
 *
 * The #125 fix corrected the APEv2 cover-art item type, and the advice given to
 * the reporter was "re-scan, then rebuild the shadow library". That could never
 * have worked, and this pins why the fix for it has to live where it does:
 *
 *  - `reconcileShadowLibrary` classifies an existing file as `verified` from the
 *    stored size+mtime alone, and for Musepack it never opens the file at all
 *    (`canSkipProbe`);
 *  - `_transcodeTrack` then returns "skipped" on row+file existence alone.
 *
 * So no code path in a rebuild reads a byte of an already-transcoded file. The
 * tag check has to be its own walk, and it has to run even when the reconcile
 * pass reports everything as fine — which is the case asserted here.
 *
 * The tag surgery itself is covered in mpc-cover-art-item-flags.test.ts.
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
import { itemFlags, itemOffset, writeLegacyMpc, AUDIO, COVER } from "../harness/legacy-mpc";

installMusicMetadataMock();

import { ShadowLibraryManager } from "../../main/library/shadow-library";
import type { ShadowBuildProgress, Track } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

describe("Shadow rebuild — repairs the tags it skips (#130)", () => {
  let db: TestDb;
  let tmpDir: string;
  let libraryDir: string;
  let shadowDir: string;
  let folderId: number;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("shadow-rebuild-retag-");
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

  /** An MPC codec configuration — quality-based, so nothing probes a bitrate. */
  function mpcConfigId(): number {
    const row = db
      .prepare(
        `SELECT cc.id FROM codec_configurations cc
         JOIN codecs c ON cc.codec_id = c.id
         WHERE c.name = 'MPC' ORDER BY cc.id LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) throw new Error("expected a seeded MPC codec configuration");
    return row.id;
  }

  function seedSource(relPath: string): Track {
    const full = path.join(libraryDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "source");
    const id = seedTrack(db, {
      path: full,
      title: path.basename(relPath),
      libraryFolderId: folderId,
      duration: 180,
      bitrate: 900_000,
      fileSize: 6,
    });
    return {
      id,
      path: full,
      filename: path.basename(relPath),
      duration: 180,
      libraryFolderId: folderId,
    } as Track;
  }

  itDb("repairs a legacy tag on a file the build never re-encodes", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("MPC", shadowDir, mpcConfigId());
    const track = seedSource("Artist/Album/song.flac");

    // Where this shadow library puts that track — written as the pre-fix
    // transcoder would have written it.
    const dest = path.join(shadowDir, "Artist", "Album", "song.mpc");
    writeLegacyMpc(dest);
    expect(itemFlags(fs.readFileSync(dest), "Cover Art (Front)")).toBe(1);
    expect(fs.readFileSync(dest).includes(COVER)).toBe(true);

    const beforeStat = fs.statSync(dest);

    const frames: ShadowBuildProgress[] = [];
    await mgr.buildShadowLibrary(
      libId,
      [track],
      new Map([[folderId, libraryDir]]),
      (p) => frames.push(p)
    );

    // Nothing was encoded: the file was adopted, then skipped. If this ever
    // reads "1 converted" the test has stopped covering the case it exists for
    // — a repair that only happens because the file got rewritten anyway.
    const done = frames[frames.length - 1];
    expect(done.status).toBe("complete");
    expect(done.logMessage).toMatch(/0 converted/);
    expect(done.logMessage).toMatch(/1 tags repaired/);

    const after = fs.readFileSync(dest);

    // The artwork is gone entirely — iPodRocks no longer embeds any (#130) —
    // while everything that is not the image survived.
    expect(after.includes(COVER)).toBe(false);
    expect(itemOffset(after, "REPLAYGAIN_TRACK_GAIN")).toBeGreaterThan(0);
    expect(after.subarray(0, AUDIO.byteLength).equals(AUDIO)).toBe(true);

    // The file is smaller for exactly that reason, but the floored mtime is
    // untouched — the value `shadow_tracks.mtime` stores and compares.
    const afterStat = fs.statSync(dest);
    expect(afterStat.size).toBeLessThan(beforeStat.size);
    expect(Math.floor(afterStat.mtimeMs)).toBe(Math.floor(beforeStat.mtimeMs));

    // The row still points at the file and still trusts its mtime. Its
    // recorded size is now the pre-repair one: `maintenance:repairMpcTags`
    // refreshes that for the files it rewrites, and a build that repairs on
    // its way past leaves it to the next reconcile, which re-stats a candidate
    // and moves on. Either way nothing re-encodes.
    const row = db
      .prepare("SELECT status, mtime FROM shadow_tracks WHERE shadow_library_id = ?")
      .get(libId) as { status: string; mtime: number };
    expect(row.status).toBe("synced");
    expect(row.mtime).toBe(Math.floor(afterStat.mtimeMs));
  });

  itDb("leaves a file it did not write alone", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("MPC", shadowDir, mpcConfigId());
    const track = seedSource("Artist/Album/song.flac");
    writeLegacyMpc(path.join(shadowDir, "Artist", "Album", "song.mpc"));

    const bystander = path.join(shadowDir, "Artist", "Album", "notes.txt");
    fs.writeFileSync(bystander, "leave me alone");

    await mgr.buildShadowLibrary(libId, [track], new Map([[folderId, libraryDir]]));

    expect(fs.readFileSync(bystander, "utf8")).toBe("leave me alone");
  });

  itDb("does not treat an unreachable shadow folder as work to do", async () => {
    const mgr = new ShadowLibraryManager(db);
    const libId = mgr.createShadowLibrary("MPC", shadowDir, mpcConfigId());
    const track = seedSource("Artist/Album/song.flac");

    // The drive holding the shadow library was unplugged between builds.
    fs.rmSync(shadowDir, { recursive: true, force: true });

    const frames: ShadowBuildProgress[] = [];
    await mgr.buildShadowLibrary(
      libId,
      [track],
      new Map([[folderId, libraryDir]]),
      (p) => frames.push(p)
    );

    expect(frames.some((f) => /tags repaired/.test(f.logMessage ?? ""))).toBe(false);
  });
});
