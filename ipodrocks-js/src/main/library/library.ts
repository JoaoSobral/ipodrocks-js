import fs from "fs";
import path from "path";
import { LibraryFolder, ShadowBuildProgress, ShadowLibrary, Track } from "../../shared/types";
import { AppDatabase } from "../database/database";
import { ContentHash, HashManager } from "./hash-manager";
import { LibraryCore } from "./library-core";
import { ShadowLibraryManager } from "./shadow-library";

type ContentType = "music" | "podcast" | "audiobook";

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
  podcastTrackCount: number;
  audiobookTrackCount: number;
}

function computeDirectorySize(root: string): number {
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return st.size;
  } catch {
    return 0;
  }

  let total = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) stack.push(full);
        else total += s.size;
      } catch {
        // best effort: ignore inaccessible files
      }
    }
  }

  return total;
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
  private shadowManager: ShadowLibraryManager;

  constructor(dbPath?: string) {
    this.database = new AppDatabase(dbPath);
    this.database.initialize();
    const conn = this.database.getConnection();
    this.core = new LibraryCore(conn);
    this.hashManager = new HashManager(conn);
    this.shadowManager = new ShadowLibraryManager(conn);
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
    if (removeTracks) {
      const paths = this.core.getTrackPathsByFolderId(folderId);
      if (paths.length > 0) {
        this.shadowManager.propagateRemovedByPath(paths);
      }
    }
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
   * totalSizeBytes is computed by summing the sizes of all configured
   * library folders on disk, so it reflects the actual on-disk size.
   */
  getStats(): LibraryStats {
    const conn = this.database.getConnection();
    const count = (sql: string) =>
      (conn.prepare(sql).get() as { c: number }).c;

    const folders = conn
      .prepare("SELECT path FROM library_folders")
      .all() as { path: string }[];
    let totalSizeBytes = 0;
    for (const f of folders) {
      totalSizeBytes += computeDirectorySize(f.path);
    }

    return {
      totalTracks: count("SELECT COUNT(*) as c FROM tracks"),
      totalAlbums: count("SELECT COUNT(*) as c FROM albums"),
      totalArtists: count("SELECT COUNT(*) as c FROM artists"),
      totalGenres: count("SELECT COUNT(*) as c FROM genres"),
      totalSizeBytes,
      podcastTrackCount: count("SELECT COUNT(*) as c FROM tracks WHERE content_type = 'podcast'"),
      audiobookTrackCount: count("SELECT COUNT(*) as c FROM tracks WHERE content_type = 'audiobook'"),
    };
  }

  // ------------------------------------------------------------------
  // Shadow Libraries
  // ------------------------------------------------------------------

  getShadowLibraries(): ShadowLibrary[] {
    return this.shadowManager.getShadowLibraries();
  }

  getShadowLibraryById(id: number): ShadowLibrary | undefined {
    return this.shadowManager.getShadowLibraryById(id);
  }

  createShadowLibrary(
    name: string,
    libPath: string,
    codecConfigId: number
  ): number {
    return this.shadowManager.createShadowLibrary(name, libPath, codecConfigId);
  }

  deleteShadowLibrary(id: number, removeFiles = true): boolean {
    return this.shadowManager.deleteShadowLibrary(id, removeFiles);
  }

  async buildShadowLibrary(
    shadowLibId: number,
    progressCallback?: (progress: ShadowBuildProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const allTracks = this.core.getTracks();
    const folders = this.core.getLibraryFolders();
    const folderPaths = new Map<number, string>();
    for (const f of folders) folderPaths.set(f.id, f.path);

    return this.shadowManager.buildShadowLibrary(
      shadowLibId,
      allTracks,
      folderPaths,
      progressCallback,
      signal
    );
  }

  /**
   * After a scan completes, propagate new/changed tracks to all shadow
   * libraries and clean up removed ones. Uses removedTrackIds (not paths)
   * because tracks are already deleted from the primary DB.
   */
  async propagateScanToShadows(
    addedPaths: string[],
    updatedPaths: string[],
    removedTrackIds: number[],
    signal?: AbortSignal
  ): Promise<void> {
    const folders = this.core.getLibraryFolders();
    const folderPaths = new Map<number, string>();
    for (const f of folders) folderPaths.set(f.id, f.path);

    const combined = [...addedPaths, ...updatedPaths];
    if (combined.length > 0) {
      await this.shadowManager.propagateAddedOrUpdated(
        combined,
        (p) => this.core.getTrackByPath(p),
        folderPaths,
        signal
      );
    }

    if (removedTrackIds.length > 0) {
      this.shadowManager.propagateRemovedByIds(removedTrackIds);
    }
  }

  getShadowTrackMap(shadowLibId: number): Map<number, string> {
    return this.shadowManager.getShadowTrackMap(shadowLibId);
  }

  getShadowManager(): ShadowLibraryManager {
    return this.shadowManager;
  }

  getConnection(): import("better-sqlite3").Database {
    return this.database.getConnection();
  }

  close(): void {
    this.database.close();
  }
}
