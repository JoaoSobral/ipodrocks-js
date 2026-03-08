import Database from "better-sqlite3";
import path from "path";
import { LibraryFolder, Track } from "../../shared/types";

type ContentType = "music" | "podcast";

interface TrackFilter {
  contentType?: ContentType;
  libraryFolderId?: number;
  limit?: number;
  offset?: number;
}

interface TrackRow {
  id: number;
  path: string;
  filename: string;
  title: string;
  track_number: number;
  disc_number: number;
  duration: number;
  bitrate: number;
  bits_per_sample: number;
  file_size: number;
  content_type: string;
  library_folder_id: number;
  file_hash: string;
  play_count: number;
  artist: string;
  album: string;
  genre: string;
  codec: string;
  metadata_hash: string;
}

interface LibraryFolderRow {
  id: number;
  name: string;
  path: string;
  content_type: string;
  created_at: string;
}

const VALID_CONTENT_TYPES = new Set(["music", "podcast"]);

const CODEC_MAP: Record<string, string> = {
  AAC: "AAC",
  ALAC: "ALAC",
  MP3: "MP3",
  FLAC: "FLAC",
  OGG: "OGG",
  VORBIS: "OGG",
  OPUS: "OPUS",
  PCM: "PCM",
  WAV: "PCM",
  AIFF: "PCM",
  MPC: "MPC",
  MUSEPACK: "MPC",
  M4A: "AAC",
  "MPEG-4": "AAC",
};

const BASE_TRACKS_QUERY = `
  SELECT t.id, t.path, t.filename, t.title, t.track_number, t.disc_number,
         t.duration, t.bitrate, t.bits_per_sample, t.file_size, t.content_type,
         t.library_folder_id, t.file_hash, t.play_count,
         COALESCE(a.name, 'Unknown Artist') as artist,
         COALESCE(al.title, 'Unknown Album') as album,
         COALESCE(g.name, 'Unknown Genre') as genre,
         COALESCE(c.name, 'Unknown Codec') as codec,
         t.metadata_hash
  FROM tracks t
  LEFT JOIN artists a ON t.artist_id = a.id
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN genres g ON t.genre_id = g.id
  LEFT JOIN codecs c ON t.codec_id = c.id
`;

/**
 * Core library management operations.
 *
 * Handles CRUD for library folders and tracks using a normalized schema
 * with get-or-create patterns for artists, albums, genres, and codecs.
 */
export class LibraryCore {
  private db: Database.Database;

  // Prepared statements cached for hot-path queries
  private stmtGetArtist: Database.Statement;
  private stmtInsertArtist: Database.Statement;
  private stmtGetAlbum: Database.Statement;
  private stmtInsertAlbum: Database.Statement;
  private stmtGetGenre: Database.Statement;
  private stmtInsertGenre: Database.Statement;
  private stmtGetCodec: Database.Statement;
  private stmtGetCodecFallback: Database.Statement;
  private stmtInsertCodecFallback: Database.Statement;
  private stmtUpsertTrack: Database.Statement;
  private stmtInsertFolder: Database.Statement;
  private stmtDeleteTrack: Database.Statement;
  private stmtGetTrackByPath: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtGetArtist = db.prepare("SELECT id FROM artists WHERE name = ?");
    this.stmtInsertArtist = db.prepare("INSERT INTO artists (name) VALUES (?)");

    this.stmtGetAlbum = db.prepare(
      "SELECT id FROM albums WHERE title = ? AND artist_id = ?"
    );
    this.stmtInsertAlbum = db.prepare(
      "INSERT INTO albums (title, artist_id) VALUES (?, ?)"
    );

    this.stmtGetGenre = db.prepare("SELECT id FROM genres WHERE name = ?");
    this.stmtInsertGenre = db.prepare("INSERT INTO genres (name) VALUES (?)");

    this.stmtGetCodec = db.prepare("SELECT id FROM codecs WHERE name = ?");
    this.stmtGetCodecFallback = db.prepare(
      "SELECT id FROM codecs WHERE name = 'Unknown'"
    );
    this.stmtInsertCodecFallback = db.prepare(
      "INSERT INTO codecs (name, description) VALUES ('Unknown', 'Unknown or unsupported codec')"
    );

    this.stmtUpsertTrack = db.prepare(`
      INSERT INTO tracks(path, filename, title, track_number, disc_number,
        duration, bitrate, bits_per_sample, file_size, content_type,
        library_folder_id, artist_id, album_id, genre_id, codec_id,
        file_hash, metadata_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET
        filename=excluded.filename,
        title=excluded.title,
        track_number=excluded.track_number,
        disc_number=excluded.disc_number,
        duration=excluded.duration,
        bitrate=excluded.bitrate,
        bits_per_sample=excluded.bits_per_sample,
        file_size=excluded.file_size,
        content_type=excluded.content_type,
        library_folder_id=excluded.library_folder_id,
        artist_id=excluded.artist_id,
        album_id=excluded.album_id,
        genre_id=excluded.genre_id,
        codec_id=excluded.codec_id,
        file_hash=excluded.file_hash,
        metadata_hash=excluded.metadata_hash
    `);

    this.stmtInsertFolder = db.prepare(
      "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
    );

    this.stmtDeleteTrack = db.prepare("DELETE FROM tracks WHERE path = ?");

    this.stmtGetTrackByPath = db.prepare(
      BASE_TRACKS_QUERY + " WHERE t.path = ?"
    );
  }

  /**
   * Add a new library folder.
   *
   * @param name - Display name for the folder
   * @param folderPath - Full path to the folder
   * @param contentType - 'music' or 'podcast'
   * @returns ID of the newly created folder
   * @throws If contentType is invalid
   */
  addLibraryFolder(
    name: string,
    folderPath: string,
    contentType: ContentType
  ): number {
    if (!VALID_CONTENT_TYPES.has(contentType)) {
      throw new Error("contentType must be 'music' or 'podcast'");
    }
    const resolved = path.resolve(folderPath);
    const info = this.stmtInsertFolder.run(name, resolved, contentType);
    return Number(info.lastInsertRowid);
  }

  /**
   * Modify an existing library folder.
   *
   * @returns true if the folder was updated, false if not found
   */
  modifyLibraryFolder(
    folderId: number,
    name: string,
    folderPath: string,
    contentType: ContentType
  ): boolean {
    if (!VALID_CONTENT_TYPES.has(contentType)) {
      throw new Error("contentType must be 'music' or 'podcast'");
    }
    const resolved = path.resolve(folderPath);
    const info = this.db
      .prepare(
        "UPDATE library_folders SET name = ?, path = ?, content_type = ? WHERE id = ?"
      )
      .run(name, resolved, contentType, folderId);
    return info.changes > 0;
  }

  /**
   * Get library folders, optionally filtered by content type.
   *
   * @param contentType - Optional filter
   * @returns Array of library folder objects
   */
  getLibraryFolders(contentType?: ContentType): LibraryFolder[] {
    let rows: LibraryFolderRow[];
    if (contentType) {
      rows = this.db
        .prepare(
          "SELECT id, name, path, content_type, created_at FROM library_folders WHERE content_type = ?"
        )
        .all(contentType) as LibraryFolderRow[];
    } else {
      rows = this.db
        .prepare(
          "SELECT id, name, path, content_type, created_at FROM library_folders"
        )
        .all() as LibraryFolderRow[];
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      contentType: r.content_type,
    }));
  }

  /**
   * Add or update a track in the library using normalized schema.
   *
   * Uses get-or-create for artists, albums, genres, and codec lookup.
   * The entire operation runs inside a transaction for atomicity.
   *
   * @param trackPath - Full file path
   * @param filename - Just the filename
   * @param title - Track title
   * @param trackNumber - Track number (e.g. "1/16")
   * @param discNumber - Disc number (e.g. "1/2")
   * @param duration - Duration in seconds
   * @param bitrate - Bitrate in bps
   * @param bitsPerSample - Bits per sample for lossless formats
   * @param fileSize - File size in bytes
   * @param contentType - 'music' or 'podcast'
   * @param libraryFolderId - ID of the library folder
   * @param artistName - Artist name
   * @param albumTitle - Album title
   * @param genreName - Genre name
   * @param codecName - Codec name (auto-normalized)
   * @param fileHash - SHA256 of file content
   * @param metadataHash - Hash of core metadata fields
   */
  addOrUpdateTrack(
    trackPath: string,
    filename: string,
    title: string,
    trackNumber: string,
    discNumber: string,
    duration: number | null,
    bitrate: number | null,
    bitsPerSample: number | null,
    fileSize: number | null,
    contentType: ContentType,
    libraryFolderId: number,
    artistName: string,
    albumTitle: string,
    genreName: string,
    codecName: string,
    fileHash: string,
    metadataHash: string | null = null
  ): void {
    const doUpsert = this.db.transaction(() => {
      const artistId = this._getOrCreateArtist(artistName);
      const albumId = this._getOrCreateAlbum(albumTitle, artistId);
      const genreId = this._getOrCreateGenre(genreName);
      const codecId = this._getCodecId(codecName);

      this.stmtUpsertTrack.run(
        trackPath,
        filename,
        title,
        trackNumber,
        discNumber,
        duration,
        bitrate,
        bitsPerSample,
        fileSize,
        contentType,
        libraryFolderId,
        artistId,
        albumId,
        genreId,
        codecId,
        fileHash,
        metadataHash
      );
    });
    doUpsert();
  }

  /**
   * Get tracks from the library with optional filtering.
   *
   * Performs JOINs to denormalize artist/album/genre/codec names.
   *
   * @param filter - Optional contentType, libraryFolderId, limit, offset
   * @returns Array of Track objects
   */
  getTracks(filter?: TrackFilter): Track[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.contentType) {
      conditions.push("t.content_type = ?");
      params.push(filter.contentType);
    }
    if (filter?.libraryFolderId != null) {
      conditions.push("t.library_folder_id = ?");
      params.push(filter.libraryFolderId);
    }

    let sql = BASE_TRACKS_QUERY;
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    if (filter?.limit != null) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    if (filter?.offset != null) {
      sql += " OFFSET ?";
      params.push(filter.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as TrackRow[];
    return rows.map(this._rowToTrack);
  }

  /**
   * Look up a single track by its file path.
   *
   * @returns Track or undefined if not found
   */
  getTrackByPath(trackPath: string): Track | undefined {
    const row = this.stmtGetTrackByPath.get(trackPath) as
      | TrackRow
      | undefined;
    return row ? this._rowToTrack(row) : undefined;
  }

  /**
   * Delete a track by file path.
   *
   * @returns true if the track was deleted
   */
  deleteTrack(trackPath: string): boolean {
    const info = this.stmtDeleteTrack.run(trackPath);
    return info.changes > 0;
  }

  /**
   * Remove a library folder and optionally its tracks.
   *
   * @param folderId - ID of the folder to remove
   * @param removeTracks - Also remove all tracks in this folder
   * @returns true if the folder was removed
   */
  removeLibraryFolder(folderId: number, removeTracks = false): boolean {
    const folder = this.db
      .prepare("SELECT name, path FROM library_folders WHERE id = ?")
      .get(folderId) as { name: string; path: string } | undefined;
    if (!folder) return false;

    const countRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tracks WHERE library_folder_id = ?")
      .get(folderId) as { cnt: number };
    const trackCount = countRow.cnt;

    if (trackCount > 0 && !removeTracks) {
      return false;
    }

    const doRemove = this.db.transaction(() => {
      if (removeTracks) {
        this.db
          .prepare("DELETE FROM tracks WHERE library_folder_id = ?")
          .run(folderId);
        const folderPathNorm = folder.path.replace(/\/$/, "") || folder.path;
        const likePattern = folderPathNorm + "/%";
        this.db
          .prepare("DELETE FROM content_hashes WHERE file_path LIKE ?")
          .run(likePattern);
      }
      this.db.prepare("DELETE FROM library_folders WHERE id = ?").run(folderId);
    });
    doRemove();
    return true;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _getOrCreateArtist(artistName: string): number {
    const name =
      !artistName || !artistName.trim() ? "Unknown Artist" : artistName;
    const row = this.stmtGetArtist.get(name) as { id: number } | undefined;
    if (row) return row.id;
    const info = this.stmtInsertArtist.run(name);
    return Number(info.lastInsertRowid);
  }

  private _getOrCreateAlbum(albumTitle: string, artistId: number): number {
    const title =
      !albumTitle || !albumTitle.trim() ? "Unknown Album" : albumTitle;
    const row = this.stmtGetAlbum.get(title, artistId) as
      | { id: number }
      | undefined;
    if (row) return row.id;
    const info = this.stmtInsertAlbum.run(title, artistId);
    return Number(info.lastInsertRowid);
  }

  private _getOrCreateGenre(genreName: string): number {
    const name =
      !genreName || !genreName.trim() ? "Unknown Genre" : genreName;
    const row = this.stmtGetGenre.get(name) as { id: number } | undefined;
    if (row) return row.id;
    const info = this.stmtInsertGenre.run(name);
    return Number(info.lastInsertRowid);
  }

  /**
   * Resolve a codec name to its ID.
   * Normalizes the name (e.g. WAV→PCM, VORBIS→OGG) before lookup.
   * Falls back to "Unknown" if not found in the codecs table.
   */
  private _getCodecId(codecName: string): number {
    const raw = !codecName || !codecName.trim() ? "Unknown" : codecName;
    const normalized = this._normalizeCodecName(raw.toUpperCase());

    const row = this.stmtGetCodec.get(normalized) as
      | { id: number }
      | undefined;
    if (row) return row.id;

    const fallback = this.stmtGetCodecFallback.get() as
      | { id: number }
      | undefined;
    if (fallback) return fallback.id;

    const info = this.stmtInsertCodecFallback.run();
    return Number(info.lastInsertRowid);
  }

  private _normalizeCodecName(codec: string): string {
    return CODEC_MAP[codec.toUpperCase()] ?? "Unknown";
  }

  private _rowToTrack(row: TrackRow): Track {
    return {
      id: row.id,
      path: row.path,
      filename: row.filename,
      title: row.title,
      artist: row.artist,
      album: row.album,
      genre: row.genre,
      codec: row.codec,
      duration: row.duration,
      bitrate: row.bitrate,
      bitsPerSample: row.bits_per_sample,
      fileSize: row.file_size,
      contentType: row.content_type,
      libraryFolderId: row.library_folder_id,
      fileHash: row.file_hash,
      metadataHash: row.metadata_hash,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
      playCount: row.play_count,
    };
  }
}
