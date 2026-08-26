/**
 * @vitest-environment node
 *
 * Issue #118 — upgrade path.
 *
 * Libraries scanned before rating-tag support existed have `tracks.rating`
 * NULL for every track, even ones a library manager already rated in the
 * file's own tag. A plain rescan does not repair them: the scanner skips
 * unchanged files on mtime, so their tags are never re-read. The one-shot
 * backfill re-reads only the rating tag, and only for tracks nothing has
 * rated yet.
 *
 * These tests build the pre-fix DB state by hand, then run the backfill
 * directly against a stub extractor — mirroring
 * regressions/album-artist-backfill.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canRunDbTests, createTestDb, type TestDb } from "../harness/db";
import {
  backfillRatingTags,
  isRatingTagBackfillDone,
} from "../../main/library/rating-tag-backfill";
import type { MetadataExtractor } from "../../main/library/metadata-extractor";

const itDb = it.skipIf(!canRunDbTests);

/** A stub extractor that reports the tag rating we "tagged" each file with. */
function stubExtractor(ratingByPath: Map<string, number | null>): MetadataExtractor {
  return {
    async extractRatingTag(filePath: string) {
      return ratingByPath.get(filePath) ?? null;
    },
  } as unknown as MetadataExtractor;
}

describe("rating-tag backfill (issue #118)", () => {
  let db: TestDb;
  let dir: string;
  let ratingByPath: Map<string, number | null>;
  let rated: string;
  let unrated: string;
  let alreadyRated: string;
  let missing: string;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-rating-backfill-"));
    ratingByPath = new Map();

    db.prepare(
      "INSERT INTO library_folders (id, name, path, content_type) VALUES (1, 'Music', ?, 'music')"
    ).run(dir);

    rated = path.join(dir, "rated.flac");
    unrated = path.join(dir, "unrated.flac");
    alreadyRated = path.join(dir, "already-rated.flac");
    missing = path.join(dir, "missing.flac");

    fs.writeFileSync(rated, Buffer.from("rated"));
    fs.writeFileSync(unrated, Buffer.from("unrated"));
    fs.writeFileSync(alreadyRated, Buffer.from("already"));
    // `missing` deliberately never written — simulates a track whose file was
    // removed between the DB snapshot and the backfill running.

    ratingByPath.set(rated, 8);
    ratingByPath.set(unrated, null);
    ratingByPath.set(missing, 10);

    const insertTrack = db.prepare(
      "INSERT INTO tracks (path, filename, content_type, library_folder_id, rating) VALUES (?, ?, 'music', 1, ?)"
    );
    insertTrack.run(rated, "rated.flac", null);
    insertTrack.run(unrated, "unrated.flac", null);
    insertTrack.run(alreadyRated, "already-rated.flac", 7);
    insertTrack.run(missing, "missing.flac", null);
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("starts from the pre-fix state: every affected track is unrated", () => {
    const rows = db
      .prepare("SELECT path, rating FROM tracks ORDER BY path")
      .all() as { path: string; rating: number | null }[];
    expect(rows.filter((r) => r.rating === null)).toHaveLength(3);
  });

  itDb("seeds rating from the tag only for unrated tracks whose file has one", async () => {
    const result = await backfillRatingTags(db, stubExtractor(ratingByPath));

    expect(result.skipped).toBe(false);
    // Three unrated rows exist; already-rated is never even queried.
    expect(result.processed).toBe(3);
    expect(result.seeded).toBe(1);

    const ratingOf = (p: string) =>
      (db.prepare("SELECT rating FROM tracks WHERE path = ?").get(p) as {
        rating: number | null;
      }).rating;

    expect(ratingOf(rated)).toBe(8);
    expect(ratingOf(unrated)).toBeNull();
    expect(ratingOf(alreadyRated)).toBe(7); // untouched — never queried at all
    expect(ratingOf(missing)).toBeNull(); // file gone, skipped despite a "tag"
  });

  itDb("is idempotent — a second run is skipped by the sentinel", async () => {
    await backfillRatingTags(db, stubExtractor(ratingByPath));
    expect(isRatingTagBackfillDone(db)).toBe(true);

    const second = await backfillRatingTags(db, stubExtractor(ratingByPath));
    expect(second.skipped).toBe(true);
    expect(second.processed).toBe(0);
  });

  itDb("forcing a re-run never overwrites a rating set since the first pass", async () => {
    await backfillRatingTags(db, stubExtractor(ratingByPath));

    // Something rates the previously-unrated track after the first pass —
    // a device sync, an in-app edit, or a later Swinsian tag the app is not
    // meant to re-read once a canonical value exists.
    db.prepare("UPDATE tracks SET rating = 3 WHERE path = ?").run(unrated);
    ratingByPath.set(unrated, 9); // the file's tag now disagrees

    const again = await backfillRatingTags(db, stubExtractor(ratingByPath), {
      force: true,
    });
    expect(again.skipped).toBe(false);

    const row = db
      .prepare("SELECT rating FROM tracks WHERE path = ?")
      .get(unrated) as { rating: number | null };
    expect(row.rating).toBe(3);
  });
});
