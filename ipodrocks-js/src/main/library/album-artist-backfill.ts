/**
 * One-shot backfill of album artists for libraries scanned before issue #113.
 *
 * Until #113 the `albumartist` tag was never read, and `albums.artist_id` was
 * populated from each track's own artist. Because `albums` is
 * UNIQUE(title, artist_id), a compilation fanned out into one album row per
 * contributing track artist — which made the custom-sync album picker unusable
 * and scattered the album across many folders on the device.
 *
 * A plain rescan does not fix existing rows: the scanner skips unchanged files
 * on mtime (see LibraryScanner.scan), so their tags are never re-read. This pass
 * re-reads *only* the tags — it deliberately skips file hashing and audio-info
 * probing, which dominate scan cost — and repoints each track at an album keyed
 * on its album artist.
 *
 * `content_hashes` is left untouched so mtimes and sync state are preserved.
 */
import type Database from "better-sqlite3";
import * as fs from "fs";
import type { MetadataExtractor } from "./metadata-extractor";

const SENTINEL_KEY = "album_artist_backfill_done";

export interface AlbumArtistBackfillResult {
  /** Tracks whose tags were re-read. */
  processed: number;
  /** Tracks repointed at a different album row. */
  repointed: number;
  /** True when the sentinel was already set and nothing ran. */
  skipped: boolean;
}

export function isAlbumArtistBackfillDone(db: Database.Database): boolean {
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

interface Row {
  id: number;
  path: string;
  album_id: number | null;
  artist_name: string | null;
  album_title: string | null;
}

/**
 * Re-read album-artist tags for every music track and repoint album rows.
 *
 * Idempotent: guarded by an app_settings sentinel, and re-running after the
 * sentinel is cleared converges to the same album rows.
 */
export async function backfillAlbumArtists(
  db: Database.Database,
  extractor: MetadataExtractor,
  options: {
    onProgress?: (processed: number, total: number) => void;
    cancelSignal?: AbortSignal;
    /** Run even when the sentinel is already set. */
    force?: boolean;
  } = {}
): Promise<AlbumArtistBackfillResult> {
  if (!options.force && isAlbumArtistBackfillDone(db)) {
    return { processed: 0, repointed: 0, skipped: true };
  }

  const rows = db
    .prepare(
      `SELECT t.id, t.path, t.album_id,
              a.name AS artist_name, al.title AS album_title
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.content_type = 'music' AND t.album_id IS NOT NULL`
    )
    .all() as Row[];

  const getArtist = db.prepare("SELECT id FROM artists WHERE name = ?");
  const insertArtist = db.prepare(
    "INSERT OR IGNORE INTO artists (name) VALUES (?)"
  );
  const getAlbum = db.prepare(
    "SELECT id FROM albums WHERE title = ? AND artist_id = ?"
  );
  const insertAlbum = db.prepare(
    "INSERT OR IGNORE INTO albums (title, artist_id) VALUES (?, ?)"
  );
  const updateTrackAlbum = db.prepare(
    "UPDATE tracks SET album_id = ? WHERE id = ?"
  );

  const artistId = (name: string): number => {
    insertArtist.run(name);
    return (getArtist.get(name) as { id: number }).id;
  };
  const albumId = (title: string, artist: number): number => {
    insertAlbum.run(title, artist);
    return (getAlbum.get(title, artist) as { id: number }).id;
  };

  // Tag reads are the slow part and must not hold a write transaction open, so
  // resolve every track's album artist first, then apply the updates in one go.
  const pending: { trackId: number; albumId: number }[] = [];
  let processed = 0;

  for (const row of rows) {
    if (options.cancelSignal?.aborted) break;
    processed++;
    options.onProgress?.(processed, rows.length);

    if (!row.album_title) continue;
    if (!fs.existsSync(row.path)) continue;

    let albumArtist: string;
    try {
      const meta = await extractor.extractMetadata(row.path, "music");
      albumArtist = (meta.albumArtist || meta.artist || "").trim();
    } catch {
      continue;
    }
    if (!albumArtist) continue;
    // Nothing to do when the album artist already matches the track artist —
    // the existing album row is already keyed correctly.
    if (albumArtist === (row.artist_name ?? "").trim()) continue;

    pending.push({
      trackId: row.id,
      albumId: albumId(row.album_title, artistId(albumArtist)),
    });
  }

  let repointed = 0;
  db.transaction(() => {
    for (const { trackId, albumId: target } of pending) {
      const res = updateTrackAlbum.run(target, trackId);
      if (res.changes > 0) repointed++;
    }
  })();

  if (!options.cancelSignal?.aborted) markDone(db);

  return { processed, repointed, skipped: false };
}
