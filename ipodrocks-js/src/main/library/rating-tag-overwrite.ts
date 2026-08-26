/**
 * Force-overwrite ratings from file tags — the opt-in "Library tags always
 * win" setting (`prefs.ts`'s `RatingPrefs.tagRatingAlwaysWins`, off by
 * default).
 *
 * Unlike the seed-once backfill (`rating-tag-backfill.ts`), which only ever
 * fills in a track nothing has rated yet, this makes the file's own tag
 * authoritative for every track in the folder just scanned — including
 * clearing a track's rating when the file carries no tag at all — and closes
 * out any open `rating_conflicts` against those tracks as "the library wins."
 * It runs on every scan while the setting stays on, with no sentinel: this is
 * meant as a "reset iPodRocks to match my library manager" action the user
 * turns on deliberately, not a one-time migration. See CLAUDE.md's rating
 * hazards for why a rating set by a device or in-app otherwise never loses to
 * the file tag once it exists.
 */
import type Database from "better-sqlite3";
import * as fs from "fs";
import type { MetadataExtractor } from "./metadata-extractor";

export interface RatingTagOverwriteResult {
  /** Tracks in the folder whose file was checked. */
  processed: number;
  /** Tracks whose canonical rating actually changed. */
  changed: number;
  /** Open rating_conflicts closed as "library wins" along the way. */
  conflictsResolved: number;
}

/**
 * Overwrite `tracks.rating` from each track's file tag for one library
 * folder, and resolve any open conflicts on the tracks it touches.
 */
export async function overwriteRatingsFromTags(
  db: Database.Database,
  extractor: MetadataExtractor,
  folderId: number,
  options: { cancelSignal?: AbortSignal } = {}
): Promise<RatingTagOverwriteResult> {
  const rows = db
    .prepare("SELECT id, path, rating FROM tracks WHERE library_folder_id = ?")
    .all(folderId) as { id: number; path: string; rating: number | null }[];

  const updateRating = db.prepare(`
    UPDATE tracks SET
      rating = ?,
      rating_source_device_id = NULL,
      rating_updated_at = CURRENT_TIMESTAMP,
      rating_version = rating_version + 1
    WHERE id = ?
  `);
  const resolveConflicts = db.prepare(`
    UPDATE rating_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = 'canonical_wins'
    WHERE track_id = ? AND resolved_at IS NULL
  `);

  let processed = 0;
  let changed = 0;
  let conflictsResolved = 0;

  for (const row of rows) {
    if (options.cancelSignal?.aborted) break;
    processed++;

    if (!fs.existsSync(row.path)) continue;

    let tagRating: number | null;
    try {
      tagRating = await extractor.extractRatingTag(row.path);
    } catch {
      continue;
    }

    if (tagRating !== row.rating) {
      updateRating.run(tagRating, row.id);
      changed++;
    }

    // Steamrolled regardless of whether the value just changed: the whole
    // point of this mode is that the library's word is final, so a conflict
    // left open from an earlier device disagreement must not linger.
    const result = resolveConflicts.run(row.id);
    conflictsResolved += result.changes;
  }

  return { processed, changed, conflictsResolved };
}
