import * as crypto from "crypto";
import * as fs from "fs";
import Database from "better-sqlite3";

/**
 * Represents a content hash record for fast file comparison.
 */
export interface ContentHash {
  filePath: string;
  contentHash: string;
  metadataHash: string;
  fileSize: number;
  lastModified: string;
  hashType: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ContentHashRow {
  file_path: string;
  content_hash: string;
  metadata_hash: string;
  file_size: number;
  last_modified: string;
  hash_type: string;
  created_at: string;
  updated_at: string;
}

/**
 * Hash-based file comparison system.
 *
 * Provides efficient content and metadata hashing for fast file comparison
 * during sync operations, dramatically improving performance for large libraries.
 */
export class HashManager {
  private db: Database.Database;

  private stmtGetHash: Database.Statement;
  private stmtUpsertHash: Database.Statement;
  private stmtDeleteHash: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtGetHash = db.prepare(`
      SELECT file_path, content_hash, metadata_hash, file_size,
             last_modified, hash_type, created_at, updated_at
      FROM content_hashes
      WHERE file_path = ?
    `);

    this.stmtUpsertHash = db.prepare(`
      INSERT OR REPLACE INTO content_hashes
        (file_path, content_hash, metadata_hash, file_size, last_modified, hash_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    this.stmtDeleteHash = db.prepare(
      "DELETE FROM content_hashes WHERE file_path = ?"
    );
  }

  /**
   * Remove all rows from content_hashes (e.g. after clearing the library).
   *
   * @returns Number of rows deleted
   */
  clearAll(): number {
    const result = this.db.prepare("DELETE FROM content_hashes").run();
    return result.changes;
  }

  /**
   * Compute SHA256 hash of file content, reading in chunks.
   *
   * @param filePath - Absolute path to the file
   * @param chunkSize - Read buffer size in bytes (default 8192)
   * @returns Hex-encoded SHA256 digest, or empty string on failure
   */
  computeFileHash(filePath: string, chunkSize = 8192): string {
    try {
      const hash = crypto.createHash("sha256");
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(chunkSize);
      let bytesRead: number;
      while ((bytesRead = fs.readSync(fd, buf, 0, chunkSize, null)) > 0) {
        hash.update(buf.subarray(0, bytesRead));
      }
      fs.closeSync(fd);
      return hash.digest("hex");
    } catch {
      return "";
    }
  }

  /**
   * Compute SHA256 hash of metadata fields.
   *
   * Normalizes empty artist/album/genre fields to match library storage
   * conventions ("Unknown Artist", "Unknown Album", "Unknown Genre") so
   * hash comparisons work correctly between library and device tracks.
   *
   * @param metadata - Object with artist, album, title, genre, and optional filename
   * @returns Hex-encoded SHA256 digest
   */
  computeMetadataHash(metadata: Record<string, unknown>): string {
    const normalized: Record<string, string> = {
      artist: this._normalizeField(
        String(metadata.artist ?? ""),
        "Unknown Artist"
      ),
      album: this._normalizeField(
        String(metadata.album ?? ""),
        "Unknown Album"
      ),
      title: (
        String(metadata.title ?? "") || String(metadata.filename ?? "")
      ).trim(),
      genre: this._normalizeField(
        String(metadata.genre ?? ""),
        "Unknown Genre"
      ),
    };

    const sorted = Object.keys(normalized)
      .sort()
      .reduce<Record<string, string>>((acc, k) => {
        acc[k] = normalized[k];
        return acc;
      }, {});

    const json = JSON.stringify(sorted);
    return crypto.createHash("sha256").update(json).digest("hex");
  }

  /**
   * Retrieve stored hash record for a file path.
   *
   * @returns ContentHash or null if not found
   */
  getHash(filePath: string): ContentHash | null {
    const row = this.stmtGetHash.get(filePath) as ContentHashRow | undefined;
    if (!row) return null;
    return this._rowToContentHash(row);
  }

  /**
   * Store (upsert) a content hash record.
   *
   * @param hash - ContentHash to persist
   * @returns true on success
   */
  storeHash(hash: ContentHash): boolean {
    try {
      this.stmtUpsertHash.run(
        hash.filePath,
        hash.contentHash,
        hash.metadataHash,
        hash.fileSize,
        hash.lastModified,
        hash.hashType
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove stored hash for a file path.
   *
   * @returns true if a row was deleted
   */
  removeHash(filePath: string): boolean {
    const info = this.stmtDeleteHash.run(filePath);
    return info.changes > 0;
  }

  /**
   * Get all files whose hash was updated after a given ISO timestamp.
   */
  getChangedFiles(sinceIso: string): ContentHash[] {
    const rows = this.db
      .prepare(
        `SELECT file_path, content_hash, metadata_hash, file_size,
                last_modified, hash_type, created_at, updated_at
         FROM content_hashes
         WHERE updated_at > ?
         ORDER BY updated_at DESC`
      )
      .all(sinceIso) as ContentHashRow[];
    return rows.map(this._rowToContentHash);
  }

  /**
   * Compute a full ContentHash for a file (content hash + metadata hash + file info).
   */
  computeContentHash(
    filePath: string,
    metadata: Record<string, unknown>
  ): ContentHash {
    const stat = fs.statSync(filePath);
    return {
      filePath,
      contentHash: this.computeFileHash(filePath),
      metadataHash: this.computeMetadataHash(metadata),
      fileSize: stat.size,
      lastModified: new Date(stat.mtimeMs).toISOString(),
      hashType: "sha256",
    };
  }

  /**
   * Statistics about the content_hashes table.
   */
  getHashStats(): {
    totalFiles: number;
    uniqueContentHashes: number;
    uniqueMetadataHashes: number;
    totalSizeBytes: number;
  } {
    const total = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM content_hashes")
        .get() as { c: number }
    ).c;
    const uniqueContent = (
      this.db
        .prepare("SELECT COUNT(DISTINCT content_hash) as c FROM content_hashes")
        .get() as { c: number }
    ).c;
    const uniqueMeta = (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT metadata_hash) as c FROM content_hashes"
        )
        .get() as { c: number }
    ).c;
    const totalSize = (
      this.db
        .prepare("SELECT COALESCE(SUM(file_size),0) as s FROM content_hashes")
        .get() as { s: number }
    ).s;

    return {
      totalFiles: total,
      uniqueContentHashes: uniqueContent,
      uniqueMetadataHashes: uniqueMeta,
      totalSizeBytes: totalSize,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private _normalizeField(value: string, fallback: string): string {
    if (!value || !value.trim()) return fallback;
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === fallback.toLowerCase()) return fallback;
    return trimmed;
  }

  private _rowToContentHash(row: ContentHashRow): ContentHash {
    return {
      filePath: row.file_path,
      contentHash: row.content_hash,
      metadataHash: row.metadata_hash,
      fileSize: row.file_size,
      lastModified: row.last_modified,
      hashType: row.hash_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
