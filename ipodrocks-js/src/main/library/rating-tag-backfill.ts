/**
 * One-shot backfill of ratings embedded in file tags, for libraries scanned
 * before issue #118 added rating-tag support.
 *
 * A plain rescan does not fix existing rows: the scanner skips unchanged files
 * on mtime (see LibraryScanner.scanFolder), so a rating a library manager
 * (Swinsian, Mp3tag, foobar2000, …) wrote into a file's own tag — ID3 POPM, a
 * Vorbis `RATING` comment, etc. — before iPodRocks ever scanned it is never
 * read. This pass re-reads *only* the rating tag, and only for tracks nothing
 * has rated yet (`tracks.rating IS NULL`).
 *
 * It never overwrites an existing rating. Once a track has a rating — from a
 * device sync, an in-app edit, or a previous tag read — the file tag stops
 * being consulted; see mergeRating() in sync/rating-merge.ts for why the
 * library, the device and the app must never fight over one already-rated
 * track.
 */
import type Database from "better-sqlite3";
import * as fs from "fs";
import type { MetadataExtractor } from "./metadata-extractor";

const SENTINEL_KEY = "rating_tag_backfill_done";

export interface RatingTagBackfillResult {
  /** Unrated tracks whose tags were checked. */
  processed: number;
  /** Tracks that got a rating from their tag. */
  seeded: number;
  /** True when the sentinel was already set and nothing ran. */
  skipped: boolean;
}

export function isRatingTagBackfillDone(db: Database.Database): boolean {
  try {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(SENTINEL_KEY) as { value: string } | undefined;
    return row?.value === "1";
  } catch {
    return false;
  }
}

function markDone(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '1', CURRENT_TIMESTAMP)"
  ).run(SENTINEL_KEY);
}

/**
 * Re-read the rating tag for every currently-unrated track and seed
 * `tracks.rating` where one is present.
 *
 * Idempotent: guarded by an app_settings sentinel, and safe to re-run after
 * the sentinel is cleared — a track that already picked up a rating (from
 * here or anywhere else) is never revisited.
 */
export async function backfillRatingTags(
  db: Database.Database,
  extractor: MetadataExtractor,
  options: {
    onProgress?: (processed: number, total: number) => void;
    cancelSignal?: AbortSignal;
    /** Run even when the sentinel is already set. */
    force?: boolean;
  } = {}
): Promise<RatingTagBackfillResult> {
  if (!options.force && isRatingTagBackfillDone(db)) {
    return { processed: 0, seeded: 0, skipped: true };
  }

  const rows = db
    .prepare("SELECT id, path FROM tracks WHERE rating IS NULL")
    .all() as { id: number; path: string }[];

  // Guarded by `AND rating IS NULL` even though the row was selected on the
  // same condition moments ago: a device sync or an in-app edit racing this
  // backfill must win, not be clobbered by a stale tag read.
  const updateRating = db.prepare(
    "UPDATE tracks SET rating = ? WHERE id = ? AND rating IS NULL"
  );

  let processed = 0;
  let seeded = 0;

  for (const row of rows) {
    if (options.cancelSignal?.aborted) break;
    processed++;
    options.onProgress?.(processed, rows.length);

    if (!fs.existsSync(row.path)) continue;

    let tagRating: number | null;
    try {
      tagRating = await extractor.extractRatingTag(row.path);
    } catch {
      continue;
    }
    if (tagRating === null) continue;

    const res = updateRating.run(tagRating, row.id);
    if (res.changes > 0) seeded++;
  }

  if (!options.cancelSignal?.aborted) markDone(db);

  return { processed, seeded, skipped: false };
}
