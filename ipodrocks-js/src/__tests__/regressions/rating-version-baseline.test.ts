/**
 * @vitest-environment node
 *
 * Issue #138, the ingest half: a rating set in iPodRocks made every later
 * device-side edit of that track look like a two-sided change.
 *
 * `mergeRating` decides `libraryChanged` as
 * `libBaseAtLastSync !== libraryVal || ratingVersionNow > ratingVersionAtSync`,
 * and `ingestDeviceRatings` hardcoded `ratingVersionAtSync = 0` because nothing
 * stored what `tracks.rating_version` had been at the last push. Every rating
 * writer does `rating_version + 1`, so any track ever rated in the app sat at
 * version ≥ 1 forever and `libraryChanged` was permanently true. A device-only
 * edit then fell past the clean `adopt_device` arm into the both-changed one: a
 * conflict the user had to answer for a change only they had made, or — one step
 * apart — a silent `converged` to `Math.max`, which is the device edit being
 * thrown away.
 *
 * `device_track_ratings.last_pushed_rating_version` now records it, so the merge
 * can tell "the library has not moved since we pushed" from "it has".
 *
 * Run: npm test -- rating-version-baseline
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedDevice,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

import { AppDatabase } from "../../main/database/database";
import {
  ingestDeviceRatings,
  invalidatePushedRatings,
  markRatingsPropagated,
} from "../../main/sync/rating-merge";

const itDb = it.skipIf(!canRunDbTests);

describe("a rating set in the app does not make every device edit a conflict (#138)", () => {
  let db: TestDb;
  let deviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt" });
  });

  afterEach(() => closeDb(db));

  /**
   * A track rated in the app — which is what bumps rating_version — and then
   * pushed to the device, i.e. the two sides in agreement and nothing pending.
   */
  function ratedInAppAndPushed(name: string, rating: number): number {
    const id = seedTrack(db, {
      path: `/music/${name}.flac`,
      title: name,
      libraryFolderId: folderId,
    });
    db.prepare(
      `UPDATE tracks
          SET rating = ?, rating_updated_at = CURRENT_TIMESTAMP,
              rating_version = rating_version + 1
        WHERE id = ?`
    ).run(rating, id);
    markRatingsPropagated(db, deviceId, [id]);
    // The device then reported it back, establishing the baseline.
    ingestDeviceRatings(db, deviceId, new Map([[id, rating]]));
    return id;
  }

  function libraryRating(id: number): number | null {
    return (
      db.prepare("SELECT rating FROM tracks WHERE id = ?").get(id) as {
        rating: number | null;
      }
    ).rating;
  }

  function openConflicts(id: number): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM rating_conflicts WHERE track_id = ? AND resolved_at IS NULL"
        )
        .get(id) as { n: number }
    ).n;
  }

  itDb("adopts a device-only edit instead of queueing a conflict", () => {
    const id = ratedInAppAndPushed("Adopted", 8);

    // The user re-rates it on the player. Nothing changed in the library.
    const result = ingestDeviceRatings(db, deviceId, new Map([[id, 4]]));

    expect(result.adopted).toBe(1);
    expect(result.conflicts).toBe(0);
    expect(libraryRating(id)).toBe(4);
    expect(openConflicts(id)).toBe(0);
  });

  itDb("does not silently revert a one-step device edit to the higher value", () => {
    // The nastiest form: the half-step tolerance takes Math.max, so on the
    // both-changed branch a 4-star → 3.5-star change on the player came back as
    // 4 stars with no conflict and no log line. Nothing to notice.
    const id = ratedInAppAndPushed("Lowered", 8);

    const result = ingestDeviceRatings(db, deviceId, new Map([[id, 7]]));

    expect(result.adopted).toBe(1);
    expect(result.converged).toBe(0);
    expect(libraryRating(id)).toBe(7);
  });

  itDb("still raises a conflict when both sides really did change", () => {
    // The fix must not swallow real disagreements: the whole point of the
    // version test is to catch a library edit made since the push.
    const id = ratedInAppAndPushed("Contested", 8);

    // Library moves after the push — a second in-app rating, version bumped.
    db.prepare(
      "UPDATE tracks SET rating = ?, rating_version = rating_version + 1 WHERE id = ?"
    ).run(10, id);

    const result = ingestDeviceRatings(db, deviceId, new Map([[id, 2]]));

    expect(result.conflicts).toBe(1);
    expect(openConflicts(id)).toBe(1);
    // Canonical is untouched until the user answers.
    expect(libraryRating(id)).toBe(10);
  });

  itDb("records the version on the push, and clears it with the pushed rating", () => {
    const id = ratedInAppAndPushed("Versioned", 6);

    const version = (
      db.prepare("SELECT rating_version FROM tracks WHERE id = ?").get(id) as {
        rating_version: number;
      }
    ).rating_version;
    expect(version).toBeGreaterThan(0);

    const row = () =>
      db
        .prepare(
          `SELECT last_pushed_rating, last_pushed_rating_version
             FROM device_track_ratings WHERE device_id = ? AND track_id = ?`
        )
        .get(deviceId, id) as {
        last_pushed_rating: number | null;
        last_pushed_rating_version: number | null;
      };

    expect(row().last_pushed_rating_version).toBe(version);

    // A rebuild verdict invalidates what we believe the device holds; the
    // version is only meaningful next to a pushed rating, so it goes too.
    invalidatePushedRatings(db, deviceId);
    expect(row().last_pushed_rating).toBeNull();
    expect(row().last_pushed_rating_version).toBeNull();
  });

  itDb("a track never pushed to is unaffected by the new baseline", () => {
    // No push, so no version to compare against — the device's first report
    // must still behave exactly as before.
    const id = seedTrack(db, {
      path: "/music/First.flac",
      libraryFolderId: folderId,
    });

    const result = ingestDeviceRatings(db, deviceId, new Map([[id, 9]]));

    expect(result.adopted).toBe(1);
    expect(libraryRating(id)).toBe(9);
  });
});

describe("last_pushed_rating_version migration on an existing database", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-rating-version-"));
    dbPath = path.join(dir, "ipodrock.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A database as the previous release left it: fully migrated — which matters,
   * because `migrateContentTypeAudiobook` rebuilds `tracks` from an explicit
   * column list that predates the rating columns, so a fixture built from bare
   * `SCHEMA_SQL` has no sentinel, runs that migration, and silently loses every
   * rating before this migration is even reached — then the new column back out,
   * holding one row whose push still agrees with the library and one whose
   * does not.
   */
  function createLegacyDatabase(): { agrees: number; diverged: number } {
    const migrated = new AppDatabase(dbPath);
    migrated.initialize();
    migrated.close();

    const db = new Database(dbPath);
    db.prepare(
      "ALTER TABLE device_track_ratings DROP COLUMN last_pushed_rating_version"
    ).run();
    const columns = (
      db.prepare("PRAGMA table_info(device_track_ratings)").all() as { name: string }[]
    ).map((r) => r.name);
    if (columns.includes("last_pushed_rating_version")) {
      throw new Error("fixture setup failed: legacy DB still has the column");
    }

    const mode = db
      .prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'")
      .get() as { id: number };
    const deviceId = Number(
      db
        .prepare(
          "INSERT INTO devices (name, mount_path, default_transfer_mode_id) VALUES ('iPod', '/mnt', ?)"
        )
        .run(mode.id).lastInsertRowid
    );
    const insertTrack = db.prepare(
      `INSERT INTO tracks (path, filename, title, content_type, rating, rating_version)
       VALUES (?, ?, ?, 'music', ?, ?)`
    );
    const agrees = Number(
      insertTrack.run("/music/a.flac", "a.flac", "A", 8, 3).lastInsertRowid
    );
    const diverged = Number(
      insertTrack.run("/music/b.flac", "b.flac", "B", 10, 5).lastInsertRowid
    );
    const insertDtr = db.prepare(
      "INSERT INTO device_track_ratings (device_id, track_id, last_pushed_rating) VALUES (?, ?, ?)"
    );
    insertDtr.run(deviceId, agrees, 8); // matches tracks.rating
    insertDtr.run(deviceId, diverged, 4); // library moved on after the push
    db.close();
    return { agrees, diverged };
  }

  function versionFor(trackId: number): number | null {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT last_pushed_rating_version FROM device_track_ratings WHERE track_id = ?"
      )
      .get(trackId) as { last_pushed_rating_version: number | null };
    db.close();
    return row.last_pushed_rating_version;
  }

  itDb("opens without throwing and adds the column", () => {
    createLegacyDatabase();

    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    const db = new Database(dbPath, { readonly: true });
    const columns = (
      db.prepare("PRAGMA table_info(device_track_ratings)").all() as { name: string }[]
    ).map((r) => r.name);
    db.close();
    expect(columns).toContain("last_pushed_rating_version");
  });

  itDb("backfills only the rows whose push still matches the library", () => {
    // An existing library is repaired on upgrade rather than one track at a time
    // as each happens to be pushed again.
    const { agrees, diverged } = createLegacyDatabase();

    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    expect(versionFor(agrees)).toBe(3);
    // The library genuinely changed after that push, so there is no version at
    // which the two agreed. `last_pushed_rating !== rating` already says so.
    expect(versionFor(diverged)).toBeNull();
  });

  itDb("is idempotent across a second open", () => {
    const { agrees } = createLegacyDatabase();

    for (let i = 0; i < 2; i++) {
      const app = new AppDatabase(dbPath);
      expect(() => app.initialize()).not.toThrow();
      app.close();
    }

    expect(versionFor(agrees)).toBe(3);
  });
});
