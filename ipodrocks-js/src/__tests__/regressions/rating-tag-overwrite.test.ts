/**
 * @vitest-environment node
 *
 * Issue #118 follow-up — "Library tags always win" (off by default).
 *
 * Normally a rating tag only ever seeds a track nothing has rated yet (see
 * rating-tag-import.test.ts / rating-tag-backfill.test.ts). This opt-in mode
 * flips that: the file's tag becomes authoritative for every track in the
 * scanned folder, including clearing a track the file leaves untagged, and
 * any open rating_conflicts on a touched track get closed out as "the
 * library wins" — there is no per-device arbitration once this is on.
 *
 * These tests drive `overwriteRatingsFromTags()` directly against a stub
 * extractor, mirroring regressions/rating-tag-backfill.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canRunDbTests, createTestDb, type TestDb } from "../harness/db";
import { seedDevice } from "../harness/seed";
import { overwriteRatingsFromTags } from "../../main/library/rating-tag-overwrite";
import type { MetadataExtractor } from "../../main/library/metadata-extractor";

const itDb = it.skipIf(!canRunDbTests);

function stubExtractor(ratingByPath: Map<string, number | null>): MetadataExtractor {
  return {
    async extractRatingTag(filePath: string) {
      return ratingByPath.get(filePath) ?? null;
    },
  } as unknown as MetadataExtractor;
}

describe("rating-tag overwrite — 'library tags always win' (issue #118 follow-up)", () => {
  let db: TestDb;
  let dir: string;
  let folderId: number;
  let otherFolderId: number;
  let ratingByPath: Map<string, number | null>;
  let upgraded: string; // was rated 3 by a device; tag now says 5 stars
  let downgraded: string; // was rated 8; file carries no tag at all
  let untouchedElsewhere: string; // same rating as its tag — nothing to do

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-rating-overwrite-"));
    ratingByPath = new Map();

    folderId = Number(
      db
        .prepare(
          "INSERT INTO library_folders (name, path, content_type) VALUES ('Music', ?, 'music')"
        )
        .run(dir).lastInsertRowid
    );
    otherFolderId = Number(
      db
        .prepare(
          "INSERT INTO library_folders (name, path, content_type) VALUES ('Other', ?, 'music')"
        )
        .run(dir + "-other").lastInsertRowid
    );

    upgraded = path.join(dir, "upgraded.flac");
    downgraded = path.join(dir, "downgraded.flac");
    untouchedElsewhere = path.join(dir, "unchanged.flac");
    fs.writeFileSync(upgraded, Buffer.from("upgraded"));
    fs.writeFileSync(downgraded, Buffer.from("downgraded"));
    fs.writeFileSync(untouchedElsewhere, Buffer.from("unchanged"));

    ratingByPath.set(upgraded, 10);
    ratingByPath.set(downgraded, null);
    ratingByPath.set(untouchedElsewhere, 6);

    const insertTrack = db.prepare(
      "INSERT INTO tracks (path, filename, content_type, library_folder_id, rating) VALUES (?, ?, 'music', ?, ?)"
    );
    insertTrack.run(upgraded, "upgraded.flac", folderId, 3);
    insertTrack.run(downgraded, "downgraded.flac", folderId, 8);
    insertTrack.run(untouchedElsewhere, "unchanged.flac", folderId, 6);

    const outsideFolder = path.join(dir + "-other", "outside.flac");
    insertTrack.run(outsideFolder, "outside.flac", otherFolderId, 2);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir + "-other", { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function ratingOf(p: string): number | null {
    return (
      db.prepare("SELECT rating FROM tracks WHERE path = ?").get(p) as {
        rating: number | null;
      }
    ).rating;
  }

  itDb("overwrites a track's rating to match its tag, even downward", async () => {
    const result = await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);

    expect(result.processed).toBe(3);
    expect(ratingOf(upgraded)).toBe(10);
  });

  itDb("clears a rating when the file's tag is gone — the library says unrated", async () => {
    await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);
    expect(ratingOf(downgraded)).toBeNull();
  });

  itDb("leaves a track whose canonical rating already matches its tag alone", async () => {
    const before = db
      .prepare("SELECT rating_version FROM tracks WHERE path = ?")
      .get(untouchedElsewhere) as { rating_version: number };

    const result = await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);

    const after = db
      .prepare("SELECT rating, rating_version FROM tracks WHERE path = ?")
      .get(untouchedElsewhere) as { rating: number | null; rating_version: number };
    expect(after.rating).toBe(6);
    expect(after.rating_version).toBe(before.rating_version); // no spurious bump
    expect(result.changed).toBe(2); // upgraded + downgraded only
  });

  itDb("never touches tracks in a different library folder", async () => {
    await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);
    const outsideRating = (
      db.prepare("SELECT rating FROM tracks WHERE filename = 'outside.flac'").get() as {
        rating: number | null;
      }
    ).rating;
    expect(outsideRating).toBe(2);
  });

  itDb("steamrolls an open rating conflict as 'canonical_wins' when it overwrites the track", async () => {
    const trackId = (
      db.prepare("SELECT id FROM tracks WHERE path = ?").get(upgraded) as { id: number }
    ).id;
    const deviceId = seedDevice(db, { name: "E2E iPod", mountPath: "/dev/null" });
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
       VALUES (?, ?, 4, 3, 3)`
    ).run(trackId, deviceId);

    const result = await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);

    expect(result.conflictsResolved).toBe(1);
    const conflict = db
      .prepare("SELECT resolved_at, resolution FROM rating_conflicts WHERE track_id = ?")
      .get(trackId) as { resolved_at: string | null; resolution: string | null };
    expect(conflict.resolved_at).not.toBeNull();
    expect(conflict.resolution).toBe("canonical_wins");
  });

  itDb("skips a track whose file no longer exists on disk", async () => {
    fs.rmSync(upgraded);
    const result = await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);
    expect(ratingOf(upgraded)).toBe(3); // untouched — nothing to read
    expect(result.processed).toBe(3);
  });

  itDb("runs every call, unlike the seed-once backfill — no sentinel to skip on", async () => {
    await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);
    ratingByPath.set(upgraded, 2); // the tag changes again after the first pass

    const second = await overwriteRatingsFromTags(db, stubExtractor(ratingByPath), folderId);

    expect(second.changed).toBeGreaterThanOrEqual(1);
    expect(ratingOf(upgraded)).toBe(2);
  });
});
