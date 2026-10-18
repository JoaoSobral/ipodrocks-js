/**
 * One-shot backfill of year, composer, comment and grouping, for libraries
 * scanned before iPodRocks stored them.
 *
 * They exist for the Rockbox database the sync now writes
 * (`rockbox/tagcache-sync.ts`). A plain rescan cannot fill them in: the
 * scanner skips an unchanged file on mtime (see LibraryScanner.scanFolder), so
 * a track scanned by an older version would read `<Untagged>` in Rockbox's
 * Year and Composer views forever. This pass re-reads only those four tags,
 * once, the same way `rating-tag-backfill.ts` does for ratings.
 */
import type Database from "better-sqlite3";
import * as fs from "fs";
import type { MetadataExtractor } from "./metadata-extractor";

const SENTINEL_KEY = "tag_fields_backfill_done";

export interface TagFieldsBackfillResult {
  /** Tracks whose tags were read. */
  processed: number;
  /** Tracks that gained at least one value. */
  updated: number;
  /** True when the sentinel was already set and nothing ran. */
  skipped: boolean;
}

export function isTagFieldsBackfillDone(db: Database.Database): boolean {
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
 * Re-read the four tags for every track that has none of them yet.
 *
 * A track with any of the four already set was scanned by a version that
 * stores them, so it is skipped. Each column is only ever filled, never
 * cleared: a value written by a scan racing this pass must win over a stale
 * read here.
 */
export async function backfillTagFields(
  db: Database.Database,
  extractor: MetadataExtractor,
  options: {
    onProgress?: (processed: number, total: number) => void;
    cancelSignal?: AbortSignal;
    /** Run even when the sentinel is already set. */
    force?: boolean;
  } = {}
): Promise<TagFieldsBackfillResult> {
  if (!options.force && isTagFieldsBackfillDone(db)) {
    return { processed: 0, updated: 0, skipped: true };
  }

  const rows = db
    .prepare(
      `SELECT id, path, album_id FROM tracks
        WHERE year IS NULL AND composer IS NULL AND comment IS NULL AND grouping IS NULL`
    )
    .all() as { id: number; path: string; album_id: number | null }[];

  const update = db.prepare(
    `UPDATE tracks SET
       year     = COALESCE(year, @year),
       composer = COALESCE(composer, @composer),
       comment  = COALESCE(comment, @comment),
       grouping = COALESCE(grouping, @grouping)
     WHERE id = @id`
  );
  const fillAlbumYear = db.prepare(
    "UPDATE albums SET year = ? WHERE id = ? AND year IS NULL"
  );

  let processed = 0;
  let updated = 0;

  for (const row of rows) {
    if (options.cancelSignal?.aborted) break;
    processed++;
    options.onProgress?.(processed, rows.length);

    if (!fs.existsSync(row.path)) continue;

    const fields = await extractor.extractTagFields(row.path).catch(() => null);
    if (!fields) continue;
    if (
      fields.year == null &&
      fields.composer == null &&
      fields.comment == null &&
      fields.grouping == null
    ) {
      continue;
    }

    const res = update.run({ id: row.id, ...fields });
    if (res.changes > 0) updated++;
    if (fields.year != null && row.album_id != null) {
      fillAlbumYear.run(fields.year, row.album_id);
    }
  }

  if (!options.cancelSignal?.aborted) markDone(db);

  return { processed, updated, skipped: false };
}
