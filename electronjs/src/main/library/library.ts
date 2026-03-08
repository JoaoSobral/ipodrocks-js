import fs from "fs";
import { LibraryFolder, Track } from "../../shared/types";
import { AppDatabase } from "../database/database";
import { ContentHash, HashManager } from "./hash-manager";
import { LibraryCore } from "./library-core";

type ContentType = "music" | "podcast";

interface TrackFilter {
  contentType?: ContentType;
  libraryFolderId?: number;
  limit?: number;
  offset?: number;
}

interface LibraryStats {
  totalTracks: number;
  totalAlbums: number;
  totalArtists: number;
  totalGenres: number;
  totalSizeBytes: number;
}

/**
 * High-level library facade.
 *
 * Creates and owns the AppDatabase, LibraryCore, and HashManager instances.
 * Delegates track operations to LibraryCore and hash operations to HashManager.
 */
export class Library {
  private database: AppDatabase;
  private core: LibraryCore;
  private hashManager: HashManager;

  constructor(dbPath?: string) {
    this.database = new AppDatabase(dbPath);
    this.database.initialize();
    const conn = this.database.getConnection();
    this.core = new LibraryCore(conn);
    this.hashManager = new HashManager(conn);
  }

  // ------------------------------------------------------------------
  // Library folders
  // ------------------------------------------------------------------

  addLibraryFolder(
    name: string,
    folderPath: string,
    contentType: ContentType
  ): number {
    return this.core.addLibraryFolder(name, folderPath, contentType);
  }

  modifyLibraryFolder(
    folderId: number,
    name: string,
    folderPath: string,
    contentType: ContentType
  ): boolean {
    return this.core.modifyLibraryFolder(folderId, name, folderPath, contentType);
  }

  getLibraryFolders(contentType?: ContentType): LibraryFolder[] {
    return this.core.getLibraryFolders(contentType);
  }

  removeLibraryFolder(folderId: number, removeTracks = false): boolean {
    return this.core.removeLibraryFolder(folderId, removeTracks);
  }

  // ------------------------------------------------------------------
  // Tracks
  // ------------------------------------------------------------------

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
    this.core.addOrUpdateTrack(
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
      artistName,
      albumTitle,
      genreName,
      codecName,
      fileHash,
      metadataHash
    );
  }

  getTracks(filter?: TrackFilter): Track[] {
    return this.core.getTracks(filter);
  }

  getTrackByPath(trackPath: string): Track | undefined {
    return this.core.getTrackByPath(trackPath);
  }

  deleteTrack(trackPath: string): boolean {
    return this.core.deleteTrack(trackPath);
  }

  // ------------------------------------------------------------------
  // Hashes
  // ------------------------------------------------------------------

  computeFileHash(filePath: string): string {
    return this.hashManager.computeFileHash(filePath);
  }

  computeMetadataHash(metadata: Record<string, unknown>): string {
    return this.hashManager.computeMetadataHash(metadata);
  }

  computeContentHash(
    filePath: string,
    metadata: Record<string, unknown>
  ): ContentHash {
    return this.hashManager.computeContentHash(filePath, metadata);
  }

  getHash(filePath: string): ContentHash | null {
    return this.hashManager.getHash(filePath);
  }

  clearContentHashes(): number {
    return this.hashManager.clearAll();
  }

  storeHash(hash: ContentHash): boolean {
    return this.hashManager.storeHash(hash);
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  /**
   * Aggregate statistics across the library.
   * totalSizeBytes sums only tracks whose file still exists on disk,
   * so the size matches the filesystem (avoids counting stale/deleted files).
   */
  getStats(): LibraryStats {
    const conn = this.database.getConnection();
    const count = (sql: string) =>
      (conn.prepare(sql).get() as { c: number }).c;

    const rows = conn
      .prepare("SELECT path, file_size FROM tracks")
      .all() as { path: string; file_size: number | null }[];
    let totalSizeBytes = 0;
    for (const r of rows) {
      if (r.file_size != null && r.file_size > 0 && fs.existsSync(r.path)) {
        totalSizeBytes += r.file_size;
      }
    }

    return {
      totalTracks: count("SELECT COUNT(*) as c FROM tracks"),
      totalAlbums: count("SELECT COUNT(*) as c FROM albums"),
      totalArtists: count("SELECT COUNT(*) as c FROM artists"),
      totalGenres: count("SELECT COUNT(*) as c FROM genres"),
      totalSizeBytes,
    };
  }

  getConnection(): import("better-sqlite3").Database {
    return this.database.getConnection();
  }

  close(): void {
    this.database.close();
  }
}
