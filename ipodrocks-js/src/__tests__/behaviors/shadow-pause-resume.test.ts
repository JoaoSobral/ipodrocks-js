/**
 * Behavior test — Shadow library pause / resume state.
 *
 * Covers the fix for the "cancelled build reports as Synced and never resumes"
 * bug. Drives `ShadowLibraryManager` directly against an in-memory DB:
 *
 *   1. Aborting an in-progress build persists status `'paused'` (NOT `'ready'`),
 *      so a partial build is not mistaken for a complete one and survives
 *      navigation / restart.
 *   2. `markInterruptedBuildsPaused()` demotes crash-orphaned `'building'` rows
 *      to `'paused'` (the startup reconciliation step) while leaving finished
 *      `'ready'` libraries untouched.
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
  type TestDb,
} from "../harness";

import { ShadowLibraryManager } from "../../main/library/shadow-library";
import type { Track } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

describe("Shadow library — pause / resume state", () => {
  let db: TestDb;
  let tmpDir: string;
  let shadowDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir("shadow-pause-");
    shadowDir = path.join(tmpDir, "shadow");
    fs.mkdirSync(shadowDir, { recursive: true });
    if (canRunDbTests) db = createTestDb();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpDir);
  });

  function firstCodecConfigId(): number {
    const row = db
      .prepare("SELECT id FROM codec_configurations ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    if (!row) throw new Error("expected seeded codec_configurations");
    return row.id;
  }

  itDb("aborting a build persists 'paused', not 'ready'", async () => {
    const mgr = new ShadowLibraryManager(db);
    const id = mgr.createShadowLibrary("Paused Lib", shadowDir, firstCodecConfigId());

    // Abort before the first track is transcoded — the loop's abort check runs
    // ahead of any encoding, so a placeholder track is enough to enter the loop.
    const controller = new AbortController();
    controller.abort();

    let lastStatus: string | undefined;
    await mgr.buildShadowLibrary(
      id,
      [{ filename: "x.flac" } as Track],
      new Map(),
      (p) => {
        lastStatus = p.status;
      },
      controller.signal
    );

    expect(lastStatus).toBe("paused");
    expect(mgr.getShadowLibraryById(id)?.status).toBe("paused");
  });

  itDb("markInterruptedBuildsPaused demotes 'building' but leaves 'ready'", () => {
    const mgr = new ShadowLibraryManager(db);
    const codecId = firstCodecConfigId();
    const buildingId = mgr.createShadowLibrary("Interrupted", shadowDir, codecId);
    const readyDir = path.join(tmpDir, "ready");
    fs.mkdirSync(readyDir, { recursive: true });
    const readyId = mgr.createShadowLibrary("Done", readyDir, codecId);

    db.prepare("UPDATE shadow_libraries SET status = 'building' WHERE id = ?").run(buildingId);
    db.prepare("UPDATE shadow_libraries SET status = 'ready' WHERE id = ?").run(readyId);

    mgr.markInterruptedBuildsPaused();

    expect(mgr.getShadowLibraryById(buildingId)?.status).toBe("paused");
    expect(mgr.getShadowLibraryById(readyId)?.status).toBe("ready");
  });
});
