/**
 * Library scanning operations.
 *
 * Ported from Python's LibraryScanner — recursively walks a folder, extracts
 * metadata and audio info via MetadataExtractor (music-metadata), compares
 * file hashes to skip unchanged files, and upserts tracks into the normalised
 * SQLite schema through better-sqlite3.
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

import { ScanProgress, ScanResult } from "../../shared/types";
import { HashManager } from "./hash-manager";
import { MetadataExtractor } from "./metadata-extractor";

/** Escape LIKE special chars (% _ \) so folder paths are safe in LIKE patterns. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => "\\" + c);
}

const AUDIO_EXTENSIONS = new Set([
  ".m4a",
  ".mp3",
  ".flac",
  ".wav",
  ".aiff",
  ".aif",
  ".ogg",
  ".opus",
]);

interface TrackUpsertData {
  path: string;
  filename: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  codec: string;
  trackNumber: string;
  discNumber: string;
  duration: number;
  bitrate: number;
  bitsPerSample: number | null;
  fileSize: number;
  contentType: string;
  folderId: number;
  fileHash: string;
  metadataHash: string;
  showTitle?: string;
  episodeNumber?: string;
}

/**
 * Scans a folder tree for audio files, extracts metadata, and upserts tracks
 * into the database. Supports hash-based change detection, cancellation via
 * AbortSignal, and progress reporting through a callback.
 */
export class LibraryScanner {
  private db: Database.Database;
  private metadataExtractor: MetadataExtractor;
  private hashManager: HashManager;

  // Prepared statements — created once in the constructor for performance
  private getFolderStmt: Database.Statement;
  private insertFolderStmt: Database.Statement;
  private getArtistStmt: Database.Statement;
  private insertArtistStmt: Database.Statement;
  private getAlbumStmt: Database.Statement;
  private insertAlbumStmt: Database.Statement;
  private getGenreStmt: Database.Statement;
  private insertGenreStmt: Database.Statement;
  private getCodecStmt: Database.Statement;
  private insertCodecStmt: Database.Statement;
  private upsertTrackStmt: Database.Statement;
  private loadMtimesStmt: Database.Statement;
  private loadTrackPathsStmt: Database.Statement;
  private getTrackIdByPathStmt: Database.Statement;
  private getTrackByArtistAlbumTitleStmt: Database.Statement;
  private updateTrackFeaturesStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.metadataExtractor = new MetadataExtractor();
    this.hashManager = new HashManager(db);

    this.getFolderStmt = db.prepare(
      "SELECT id FROM library_folders WHERE path = ?"
    );
    this.insertFolderStmt = db.prepare(
      "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
    );

    this.getArtistStmt = db.prepare("SELECT id FROM artists WHERE name = ?");
    this.insertArtistStmt = db.prepare(
      "INSERT OR IGNORE INTO artists (name) VALUES (?)"
    );

    this.getAlbumStmt = db.prepare(
      "SELECT id FROM albums WHERE title = ? AND artist_id = ?"
    );
    this.insertAlbumStmt = db.prepare(
      "INSERT OR IGNORE INTO albums (title, artist_id) VALUES (?, ?)"
    );

    this.getGenreStmt = db.prepare("SELECT id FROM genres WHERE name = ?");
    this.insertGenreStmt = db.prepare(
      "INSERT OR IGNORE INTO genres (name) VALUES (?)"
    );

    this.getCodecStmt = db.prepare("SELECT id FROM codecs WHERE name = ?");
    this.insertCodecStmt = db.prepare(
      "INSERT OR IGNORE INTO codecs (name) VALUES (?)"
    );

    this.upsertTrackStmt = db.prepare(`
      INSERT INTO tracks (
        path, filename, title, track_number, disc_number, duration, bitrate,
        bits_per_sample, file_size, content_type, library_folder_id,
        artist_id, album_id, genre_id, codec_id, file_hash, metadata_hash,
        show_title, episode_number
      ) VALUES (
        @path, @filename, @title, @trackNumber, @discNumber, @duration,
        @bitrate, @bitsPerSample, @fileSize, @contentType, @folderId,
        @artistId, @albumId, @genreId, @codecId, @fileHash, @metadataHash,
        @showTitle, @episodeNumber
      )
      ON CONFLICT(path) DO UPDATE SET
        filename      = excluded.filename,
        title         = excluded.title,
        track_number  = excluded.track_number,
        disc_number   = excluded.disc_number,
        duration      = excluded.duration,
        bitrate       = excluded.bitrate,
        bits_per_sample = excluded.bits_per_sample,
        file_size     = excluded.file_size,
        content_type  = excluded.content_type,
        library_folder_id = excluded.library_folder_id,
        artist_id     = excluded.artist_id,
        album_id      = excluded.album_id,
        genre_id      = excluded.genre_id,
        codec_id      = excluded.codec_id,
        file_hash     = excluded.file_hash,
        metadata_hash = excluded.metadata_hash,
        show_title    = excluded.show_title,
        episode_number = excluded.episode_number
    `);

    this.loadMtimesStmt = db.prepare(
      "SELECT file_path, last_modified FROM content_hashes WHERE file_path LIKE ? ESCAPE '\\'"
    );
    this.loadTrackPathsStmt = db.prepare(
      "SELECT path FROM tracks WHERE path LIKE ? ESCAPE '\\'"
    );
    this.getTrackIdByPathStmt = db.prepare(
      "SELECT id FROM tracks WHERE path = ?"
    );
    this.getTrackByArtistAlbumTitleStmt = db.prepare(
      `SELECT id, path FROM tracks
       WHERE artist_id IS NOT DISTINCT FROM ?
         AND album_id IS NOT DISTINCT FROM ?
         AND ((title IS NULL AND ? IS NULL) OR (title IS NOT NULL AND ? IS NOT NULL AND LOWER(title) = LOWER(?)))
       LIMIT 1`
    );
    this.updateTrackFeaturesStmt = db.prepare(
      "UPDATE tracks SET key = ?, bpm = ?, camelot = ?, features_scanned = 1 WHERE id = ?"
    );
  }

  /**
   * Scan a folder for audio files and add/update them in the library.
   * @param folderPath   Absolute path to the folder to scan
   * @param contentType  "music", "podcast", or "audiobook"
   * @param progressCallback  Optional callback invoked for each file
   * @param signal  Optional AbortSignal for cancellation
   * @param options  Optional: scanHarmonicData (default true) - extract key/BPM when true
   * @returns Summary of files processed and added
   */
  async scanFolder(
    folderPath: string,
    contentType: string = "music",
    progressCallback?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
    options?: { scanHarmonicData?: boolean }
  ): Promise<ScanResult> {
    const scanHarmonicData = options?.scanHarmonicData !== false;
    const folder = path.resolve(folderPath.trim());
    if (!fs.existsSync(folder)) {
      return { filesAdded: 0, filesProcessed: 0, filesRemoved: 0, cancelled: false };
    }

    const folderId = this.getOrCreateFolderId(folder, contentType);
    const existingMtimes = this.loadExistingMtimes(folder);
    const audioFiles = this.collectAudioFiles(folder);
    const audioFileSet = new Set(audioFiles);
    const total = audioFiles.length;
    let filesProcessed = 0;
    let filesAdded = 0;
    const errors: string[] = [];
    const addedTrackPaths: string[] = [];
    const updatedTrackPaths: string[] = [];

    for (const filePath of audioFiles) {
      if (signal?.aborted) {
        progressCallback?.({
          file: filePath,
          processed: filesProcessed,
          total,
          status: "cancelled",
        });
        return { filesAdded, filesProcessed, filesRemoved: 0, cancelled: true };
      }

      progressCallback?.({
        file: path.basename(filePath),
        processed: filesProcessed,
        total,
        status: "scanning",
      });

      try {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${path.basename(filePath)}: ${msg}`);
          filesProcessed++;
          progressCallback?.({
            file: path.basename(filePath),
            processed: filesProcessed,
            total,
            status: "error",
          });
          continue;
        }
        const mtimeMs = stat.mtimeMs;
        const storedMtimeMs = existingMtimes.get(filePath);
        if (
          storedMtimeMs != null &&
          Math.abs(storedMtimeMs - mtimeMs) < 1000
        ) {
          filesProcessed++;
          progressCallback?.({
            file: path.basename(filePath),
            processed: filesProcessed,
            total,
            status: "skipped",
          });
          continue;
        }

        const isNew = !existingMtimes.has(filePath);

        const metadataPromise = this.metadataExtractor.extractMetadata(
          filePath,
          contentType
        );
        const audioInfoPromise =
          this.metadataExtractor.extractAudioInfo(filePath);
        const featuresPromise = scanHarmonicData
          ? this.metadataExtractor.extractAudioFeatures(filePath)
          : Promise.resolve({ key: null, bpm: null, camelot: null });
        const [metadata, audioInfo, features] = await Promise.all([
          metadataPromise,
          audioInfoPromise,
          featuresPromise,
        ]);

        const fileSize = stat.size;

        const fileHash = this.hashManager.computeFileHash(filePath);
        const metadataHash = this.hashManager.computeMetadataHash({
          artist: metadata.artist,
          album: metadata.album,
          title: metadata.title,
          genre: metadata.genre,
        });

        const didUpsert = this.upsertTrack({
          path: filePath,
          filename: path.basename(filePath),
          title: metadata.title,
          artist: metadata.artist,
          album: metadata.album,
          genre: metadata.genre,
          codec: audioInfo.codec,
          trackNumber: metadata.trackNumber,
          discNumber: metadata.discNumber,
          duration: audioInfo.duration,
          bitrate: audioInfo.bitrate,
          bitsPerSample: audioInfo.bitsPerSample,
          fileSize,
          contentType,
          folderId,
          fileHash,
          metadataHash,
          showTitle: metadata.showTitle,
          episodeNumber: metadata.episodeNumber,
        });
        if (!didUpsert) {
          filesProcessed++;
          progressCallback?.({
            file: path.basename(filePath),
            processed: filesProcessed,
            total,
            status: "skipped",
          });
          continue;
        }

        const trackRow = this.getTrackIdByPathStmt.get(filePath) as
          | { id: number }
          | undefined;
        if (trackRow && scanHarmonicData && contentType === "music") {
          this.updateTrackFeaturesStmt.run(
            features.key,
            features.bpm,
            features.camelot,
            trackRow.id
          );
        }

        if (fileSize > 0 && mtimeMs > 0) {
          this.hashManager.storeHash({
            filePath,
            contentHash: fileHash,
            metadataHash,
            fileSize,
            lastModified: new Date(mtimeMs).toISOString(),
            hashType: "sha256",
          });
        }

        filesProcessed++;
        if (isNew) {
          filesAdded++;
          addedTrackPaths.push(filePath);
        } else {
          updatedTrackPaths.push(filePath);
        }
        progressCallback?.({
          file: path.basename(filePath),
          processed: filesProcessed,
          total,
          status: "added",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`⚠️  Error processing ${filePath}:`, err);
        errors.push(`${path.basename(filePath)}: ${msg}`);
        filesProcessed++;
        progressCallback?.({
          file: path.basename(filePath),
          processed: filesProcessed,
          total,
          status: "error",
        });
      }
    }

    const existingTrackPaths = this.loadTrackPathsStmt
      .all(escapeLike(folder) + "%") as { path: string }[];
    const removedTrackPaths = existingTrackPaths
      .map((r) => r.path)
      .filter((p) => !audioFileSet.has(p));

    const { filesRemoved, removedTrackIds } =
      this.deleteRemovedTracks(removedTrackPaths);

    this.deduplicateTracks();

    progressCallback?.({
      file: "",
      processed: filesProcessed,
      total,
      status: "complete",
    });

    return {
      filesAdded,
      filesProcessed,
      filesRemoved,
      cancelled: false,
      errors,
      addedTrackPaths,
      removedTrackPaths,
      removedTrackIds,
      updatedTrackPaths,
    };
  }

  /**
   * Delete tracks by path from DB (tracks, content_hashes, playback_logs,
   * playback_stats). Cleans up orphaned albums/artists/genres/codecs.
   * Returns the number of tracks deleted and their IDs (for shadow propagation).
   */
  private deleteRemovedTracks(
    paths: string[]
  ): { filesRemoved: number; removedTrackIds: number[] } {
    if (paths.length === 0) return { filesRemoved: 0, removedTrackIds: [] };

    const pathToId = new Map<string, number>();
    for (const p of paths) {
      const row = this.getTrackIdByPathStmt.get(p) as { id: number } | undefined;
      if (row) pathToId.set(p, row.id);
    }
    const ids = [...pathToId.values()];

    const deleteTrackStmt = this.db.prepare("DELETE FROM tracks WHERE path = ?");
    const deleteHashStmt = this.db.prepare(
      "DELETE FROM content_hashes WHERE file_path = ?"
    );
    const deleteShadowStmt = this.db.prepare(
      "DELETE FROM shadow_tracks WHERE source_track_id = ?"
    );
    const deletePlaybackLogsStmt = this.db.prepare(
      "DELETE FROM playback_logs WHERE matched_track_id = ?"
    );
    const deletePlaybackStatsStmt = this.db.prepare(
      "DELETE FROM playback_stats WHERE track_id = ?"
    );

    let deleted = 0;
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        for (const p of paths) {
          const trackId = pathToId.get(p);
          if (trackId != null) {
            deletePlaybackLogsStmt.run(trackId);
            deletePlaybackStatsStmt.run(trackId);
            deleteShadowStmt.run(trackId);
          }
          deleteHashStmt.run(p);
          const info = deleteTrackStmt.run(p);
          if (info.changes > 0) deleted++;
        }
        this.cleanupOrphanedEntities();
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }

    return { filesRemoved: deleted, removedTrackIds: ids };
  }

  /**
   * Remove duplicate tracks: same (artist, album, title). Prefers the path
   * that does NOT contain "Trash" (keeps main library over Trash). Runs
   * after each scan to clean up any duplicates.
   */
  private deduplicateTracks(): void {
    const dupes = this.db.prepare(`
      SELECT t.id FROM tracks t
      WHERE EXISTS (
        SELECT 1 FROM tracks t2
        WHERE t2.artist_id IS NOT DISTINCT FROM t.artist_id
          AND t2.album_id IS NOT DISTINCT FROM t.album_id
          AND (
            (t2.title IS NULL AND t.title IS NULL)
            OR (t2.title IS NOT NULL AND t.title IS NOT NULL AND LOWER(t2.title) = LOWER(t.title))
          )
          AND t2.id != t.id
          AND (
            (t.path LIKE '%Trash%' AND t2.path NOT LIKE '%Trash%')
            OR (
              (t.path LIKE '%Trash%') = (t2.path LIKE '%Trash%')
              AND t2.id < t.id
            )
          )
      )
    `).all() as { id: number }[];

    if (dupes.length === 0) return;

    const deletePlaybackLogsStmt = this.db.prepare("DELETE FROM playback_logs WHERE matched_track_id = ?");
    const deletePlaybackStatsStmt = this.db.prepare("DELETE FROM playback_stats WHERE track_id = ?");
    const deleteShadowStmt = this.db.prepare("DELETE FROM shadow_tracks WHERE source_track_id = ?");
    const getPathStmt = this.db.prepare("SELECT path FROM tracks WHERE id = ?");
    const deleteHashStmt = this.db.prepare("DELETE FROM content_hashes WHERE file_path = ?");
    const deleteTrackStmt = this.db.prepare("DELETE FROM tracks WHERE id = ?");

    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.transaction(() => {
        for (const row of dupes) {
          deletePlaybackLogsStmt.run(row.id);
          deletePlaybackStatsStmt.run(row.id);
          deleteShadowStmt.run(row.id);
          const pathRow = getPathStmt.get(row.id) as { path: string } | undefined;
          if (pathRow) {
            deleteHashStmt.run(pathRow.path);
          }
          deleteTrackStmt.run(row.id);
        }
        this.cleanupOrphanedEntities();
      })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  /** Remove albums, artists, genres, codecs with no referencing tracks. */
  private cleanupOrphanedEntities(): void {
    const orphanAlbumIds = this.db
      .prepare(
        "SELECT id FROM albums WHERE id NOT IN (SELECT DISTINCT album_id FROM tracks WHERE album_id IS NOT NULL)"
      )
      .all() as { id: number }[];
    const orphanArtistIds = this.db
      .prepare(
        `SELECT id FROM artists WHERE id NOT IN (
          SELECT artist_id FROM albums
          UNION
          SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL
        )`
      )
      .all() as { id: number }[];
    const orphanGenreIds = this.db
      .prepare(
        "SELECT id FROM genres WHERE id NOT IN (SELECT DISTINCT genre_id FROM tracks WHERE genre_id IS NOT NULL)"
      )
      .all() as { id: number }[];
    const orphanCodecIds = this.db
      .prepare(
        "SELECT id FROM codecs WHERE id NOT IN (SELECT DISTINCT codec_id FROM tracks WHERE codec_id IS NOT NULL)"
      )
      .all() as { id: number }[];

    const albumIds = orphanAlbumIds.map((r) => r.id);
    const artistIds = orphanArtistIds.map((r) => r.id);
    const genreIds = orphanGenreIds.map((r) => r.id);
    const codecIds = orphanCodecIds.map((r) => r.id);
    const idsToNull = [...albumIds, ...artistIds, ...genreIds];

    if (idsToNull.length > 0) {
      const placeholders = idsToNull.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE sync_rules SET target_id = NULL WHERE target_id IN (${placeholders})`
      ).run(...idsToNull);
    }

    if (albumIds.length > 0) {
      const ph = albumIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM albums WHERE id IN (${ph})`).run(...albumIds);
    }
    if (artistIds.length > 0) {
      const ph = artistIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM artists WHERE id IN (${ph})`).run(...artistIds);
    }
    if (genreIds.length > 0) {
      const ph = genreIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM genres WHERE id IN (${ph})`).run(...genreIds);
    }
    if (codecIds.length > 0) {
      const ph = codecIds.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM codecs WHERE id IN (${ph})`).run(...codecIds);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Recursively collect all audio files under a directory.
   * Manual walk to stay compatible with Node 18 (no recursive readdirSync
   * with withFileTypes).
   */
  private collectAudioFiles(dir: string): string[] {
    const files: string[] = [];
    const walk = (current: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.isFile() &&
          AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          files.push(full);
        }
      }
    };
    walk(dir);
    return files;
  }

  /** Load path → last_modified (ms) from content_hashes for mtime-based skip. */
  private loadExistingMtimes(folder: string): Map<string, number> {
    const pattern = escapeLike(folder) + "%";
    const rows = this.loadMtimesStmt.all(pattern) as {
      file_path: string;
      last_modified: string;
    }[];
    const map = new Map<string, number>();
    for (const r of rows) {
      const ms = new Date(r.last_modified).getTime();
      if (!Number.isNaN(ms)) map.set(r.file_path, ms);
    }
    return map;
  }

  /** Get or create the library_folders row for this path. */
  private getOrCreateFolderId(folder: string, contentType: string): number {
    const row = this.getFolderStmt.get(folder) as { id: number } | undefined;
    if (row) return row.id;

    const info = this.insertFolderStmt.run(
      path.basename(folder),
      folder,
      contentType
    );
    return info.lastInsertRowid as number;
  }

  /** Get or create an artist row, returning its id. */
  private getOrCreateArtistId(name: string): number {
    this.insertArtistStmt.run(name);
    const row = this.getArtistStmt.get(name) as { id: number };
    return row.id;
  }

  /** Get or create an album row (scoped to artist), returning its id. */
  private getOrCreateAlbumId(title: string, artistId: number): number {
    this.insertAlbumStmt.run(title, artistId);
    const row = this.getAlbumStmt.get(title, artistId) as { id: number };
    return row.id;
  }

  /** Get or create a genre row, returning its id. */
  private getOrCreateGenreId(name: string): number {
    this.insertGenreStmt.run(name);
    const row = this.getGenreStmt.get(name) as { id: number };
    return row.id;
  }

  /** Get or create a codec row, returning its id. */
  private getOrCreateCodecId(name: string): number {
    this.insertCodecStmt.run(name);
    const row = this.getCodecStmt.get(name) as { id: number };
    return row.id;
  }

  /**
   * Backfill key/BPM/Camelot for tracks that need it (tag-based only).
   * Only selects tracks not yet scanned for features — once tag extraction
   * has been attempted, we don't retry (tags won't change unless the file
   * does, which is caught by a normal library scan).
   *
   * @param maxTracks  Max tracks to process (from percent of library).
   * @param progressCallback  Optional callback for progress updates.
   * @param signal  Optional AbortSignal to cancel the operation.
   * @returns Number of tracks processed.
   */
  async backfillFeatures(
    maxTracks = 500,
    progressCallback?: (p: {
      path: string;
      processed: number;
      total: number;
      success: boolean;
      status: "analyzing" | "complete" | "error" | "cancelled";
    }) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT id, path FROM tracks
         WHERE content_type = 'music'
           AND features_scanned = 0
         LIMIT ?`
      )
      .all(maxTracks) as { id: number; path: string }[];

    const total = rows.length;
    let processed = 0;

    for (let i = 0; i < rows.length; i++) {
      if (signal?.aborted) {
        progressCallback?.({
          path: "",
          processed: i,
          total,
          success: false,
          status: "cancelled",
        });
        break;
      }
      const row = rows[i];
      let ok = false;
      progressCallback?.({
        path: row.path,
        processed: i,
        total,
        success: false,
        status: "analyzing",
      });
      try {
        const features = await this.metadataExtractor.extractAudioFeatures(
          row.path
        );
        this.updateTrackFeaturesStmt.run(
          features.key,
          features.bpm,
          features.camelot,
          row.id
        );
        processed++;
        ok = !!features.camelot;
      } catch {
        this.db
          .prepare("UPDATE tracks SET features_scanned = 1 WHERE id = ?")
          .run(row.id);
      }
      progressCallback?.({
        path: row.path,
        processed: i + 1,
        total,
        success: ok,
        status: signal?.aborted
          ? "cancelled"
          : i + 1 === total
            ? "complete"
            : "analyzing",
      });
    }
    return processed;
  }

  /**
   * Sample tracks by genre for round-robin distribution.
   * Only selects tracks that still need analysis (no camelot data yet)
   * so that already-processed tracks are never re-analyzed.
   *
   * @param totalMusic  Total music tracks in the library (for percent calc).
   * @param percent  Percent of library to target (capped by available tracks).
   * @returns Array of {id, path} in round-robin order across genres.
   */
  private sampleTracksByGenre(
    totalMusic: number,
    percent: number
  ): Array<{ id: number; path: string }> {
    const targetCount = Math.min(
      totalMusic,
      Math.max(1, Math.ceil((totalMusic * percent) / 100))
    );
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, COALESCE(t.genre_id, 0) as genre_id
         FROM tracks t
         WHERE t.content_type = 'music'
           AND t.camelot IS NULL`
      )
      .all() as Array<{ id: number; path: string; genre_id: number }>;

    const byGenre = new Map<number, Array<{ id: number; path: string }>>();
    for (const r of rows) {
      const gid = r.genre_id;
      if (!byGenre.has(gid)) byGenre.set(gid, []);
      byGenre.get(gid)!.push({ id: r.id, path: r.path });
    }

    // Shuffle each genre's track array for random sampling
    for (const arr of byGenre.values()) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    }

    // F14: Round-robin using activeGenres array — avoids O(n) indexOf+splice on byGenre keys
    const activeGenres = [...byGenre.entries()].filter(([, arr]) => arr.length > 0);
    const selected: Array<{ id: number; path: string }> = [];
    let gi = 0;
    while (selected.length < targetCount && activeGenres.length > 0) {
      const idx = gi % activeGenres.length;
      const [, arr] = activeGenres[idx];
      selected.push(arr.pop()!);
      if (arr.length === 0) {
        activeGenres.splice(idx, 1);
        // Don't increment gi — the next genre has shifted into position idx
      } else {
        gi++;
      }
    }
    return selected;
  }

  /**
   * Backfill key/BPM using Essentia.js audio analysis.
   * Samples tracks by genre (round-robin) per the given percent.
   * @param percent  Percent of library to analyze (1–100).
   * @param progressCallback  Optional callback for progress updates.
   * @param signal  Optional AbortSignal to cancel the operation.
   * @returns Number of tracks processed.
   */
  async backfillFeaturesWithEssentia(
    percent: number,
    progressCallback?: (p: {
      path: string;
      processed: number;
      total: number;
      success: boolean;
      status: "analyzing" | "complete" | "error" | "cancelled";
    }) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const totalMusic = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'"
        )
        .get() as { c: number }
    ).c;
    if (totalMusic === 0) return 0;

    const { analyzeAudioWithEssentia } = await import(
      "../harmonic/essentia-analyzer"
    );
    const sampled = this.sampleTracksByGenre(totalMusic, percent);
    const total = sampled.length;
    let processed = 0;

    for (let i = 0; i < sampled.length; i++) {
      if (signal?.aborted) {
        progressCallback?.({
          path: "",
          processed: i,
          total,
          success: false,
          status: "cancelled",
        });
        break;
      }
      const row = sampled[i];
      let ok = false;
      progressCallback?.({
        path: row.path,
        processed: i,
        total,
        success: false,
        status: "analyzing",
      });
      try {
        const features = await analyzeAudioWithEssentia(row.path);
        if (features) {
          this.updateTrackFeaturesStmt.run(
            features.key,
            features.bpm,
            features.camelot,
            row.id
          );
          processed++;
          ok = !!features.camelot;
        } else {
          this.db
            .prepare("UPDATE tracks SET features_scanned = 1 WHERE id = ?")
            .run(row.id);
        }
      } catch {
        this.db
          .prepare("UPDATE tracks SET features_scanned = 1 WHERE id = ?")
          .run(row.id);
      }
      progressCallback?.({
        path: row.path,
        processed: i + 1,
        total,
        success: ok,
        status: signal?.aborted
          ? "cancelled"
          : i + 1 === total
            ? "complete"
            : "analyzing",
      });
    }
    return processed;
  }

  /**
   * Parse a track/disc number string like "3" or "3/12" into an integer,
   * returning null when parsing fails.
   */
  private parseIntField(value: string | undefined): number | null {
    if (!value) return null;
    const num = parseInt(value.split("/")[0], 10);
    return isNaN(num) ? null : num;
  }

  /**
   * Resolve foreign keys and upsert a track row.
   * Skips if a track with same (artist, album, title) already exists at a
   * different path (prevents duplicates from Trash or multiple folders).
   * @returns false if skipped as duplicate, true if upserted
   */
  private upsertTrack(data: TrackUpsertData): boolean {
    const artistId = this.getOrCreateArtistId(data.artist);
    const albumId = this.getOrCreateAlbumId(data.album, artistId);
    const genreId = this.getOrCreateGenreId(data.genre);
    const codecId = this.getOrCreateCodecId(data.codec);

    const existing = this.getTrackByArtistAlbumTitleStmt.get(
      artistId,
      albumId,
      data.title ?? null,
      data.title ?? null,
      data.title ?? null
    ) as { id: number; path: string } | undefined;
    if (existing && existing.path !== data.path) {
      return false;
    }

    const trackNumber = this.parseIntField(data.trackNumber);
    const discNumber = this.parseIntField(data.discNumber);

    let episodeNumber: number | null = null;
    if (data.contentType === "podcast" && data.episodeNumber) {
      episodeNumber = this.parseIntField(data.episodeNumber);
    }

    this.upsertTrackStmt.run({
      path: data.path,
      filename: data.filename,
      title: data.title,
      trackNumber,
      discNumber,
      duration: data.duration,
      bitrate: data.bitrate,
      bitsPerSample: data.bitsPerSample,
      fileSize: data.fileSize,
      contentType: data.contentType,
      folderId: data.folderId,
      artistId,
      albumId,
      genreId,
      codecId,
      fileHash: data.fileHash,
      metadataHash: data.metadataHash,
      showTitle: data.showTitle ?? null,
      episodeNumber,
    });
    return true;
  }
}
