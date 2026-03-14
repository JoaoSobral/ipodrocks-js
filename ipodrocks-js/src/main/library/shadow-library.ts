import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

import { ShadowBuildProgress, ShadowLibrary, Track } from "../../shared/types";
import {
  ConversionSettings,
  convertWithCodec,
  updateExtension,
} from "../sync/sync-conversion";
import { cleanEmptyDirectories } from "../sync/sync-core";

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

interface ShadowLibraryRow {
  id: number;
  name: string;
  path: string;
  codec_config_id: number;
  status: string;
  created_at: string;
  codec_config_name: string;
  codec_name: string;
  bitrate_value: number | null;
  quality_value: number | null;
  bits_per_sample: number | null;
  total_bytes: number;
  track_count: number;
}

interface ShadowTrackRow {
  id: number;
  shadow_library_id: number;
  source_track_id: number;
  shadow_path: string;
  status: string;
  error_message: string | null;
}

interface CodecConfigRow {
  id: number;
  name: string;
  codec_name: string;
  bitrate_value: number | null;
  quality_value: number | null;
  bits_per_sample: number | null;
}

/**
 * Manages shadow libraries: pre-transcoded mirrors of the primary library.
 *
 * Each shadow library holds a full copy of every track, converted to a
 * specific codec configuration. Changes in the primary library propagate
 * automatically (add / remove / re-transcode).
 */
export class ShadowLibraryManager {
  private db: Database.Database;

  private stmtGetAll: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtInsert: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtSetStatus: Database.Statement;
  private stmtInsertTrack: Database.Statement;
  private stmtSetTrackStatus: Database.Statement;
  private stmtDeleteTrackBySource: Database.Statement;
  private stmtGetTrackBySource: Database.Statement;
  private stmtGetCodecConfig: Database.Statement;
  private stmtGetShadowTracksByLib: Database.Statement;
  private stmtCountTracks: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    const baseQuery = `
      SELECT sl.id, sl.name, sl.path, sl.codec_config_id, sl.status,
             sl.created_at, cc.name as codec_config_name,
             c.name as codec_name,
             cc.bitrate_value, cc.quality_value, cc.bits_per_sample,
             COALESCE((
               SELECT SUM(t.file_size) FROM shadow_tracks st
               JOIN tracks t ON st.source_track_id = t.id
               WHERE st.shadow_library_id = sl.id AND st.status = 'synced'
             ), 0) as total_bytes,
             (SELECT COUNT(*) FROM shadow_tracks st
              WHERE st.shadow_library_id = sl.id) as track_count
      FROM shadow_libraries sl
      JOIN codec_configurations cc ON sl.codec_config_id = cc.id
      JOIN codecs c ON cc.codec_id = c.id
    `;

    this.stmtGetAll = db.prepare(baseQuery + " ORDER BY sl.name");
    this.stmtGetById = db.prepare(baseQuery + " WHERE sl.id = ?");

    this.stmtInsert = db.prepare(
      `INSERT INTO shadow_libraries (name, path, codec_config_id, status)
       VALUES (?, ?, ?, 'pending')`
    );

    this.stmtDelete = db.prepare(
      "DELETE FROM shadow_libraries WHERE id = ?"
    );

    this.stmtSetStatus = db.prepare(
      "UPDATE shadow_libraries SET status = ? WHERE id = ?"
    );

    this.stmtInsertTrack = db.prepare(
      `INSERT OR REPLACE INTO shadow_tracks
       (shadow_library_id, source_track_id, shadow_path, status, error_message,
        updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );

    this.stmtSetTrackStatus = db.prepare(
      `UPDATE shadow_tracks SET status = ?, error_message = ?,
              updated_at = CURRENT_TIMESTAMP
       WHERE shadow_library_id = ? AND source_track_id = ?`
    );

    this.stmtDeleteTrackBySource = db.prepare(
      `DELETE FROM shadow_tracks
       WHERE shadow_library_id = ? AND source_track_id = ?`
    );

    this.stmtGetTrackBySource = db.prepare(
      `SELECT id, shadow_library_id, source_track_id, shadow_path,
              status, error_message
       FROM shadow_tracks
       WHERE shadow_library_id = ? AND source_track_id = ?`
    );

    this.stmtGetCodecConfig = db.prepare(
      `SELECT cc.id, cc.name, c.name as codec_name,
              cc.bitrate_value, cc.quality_value, cc.bits_per_sample
       FROM codec_configurations cc
       JOIN codecs c ON cc.codec_id = c.id
       WHERE cc.id = ?`
    );

    this.stmtGetShadowTracksByLib = db.prepare(
      `SELECT id, shadow_library_id, source_track_id, shadow_path,
              status, error_message
       FROM shadow_tracks WHERE shadow_library_id = ?`
    );

    this.stmtCountTracks = db.prepare(
      "SELECT COUNT(*) as cnt FROM shadow_tracks WHERE shadow_library_id = ?"
    );
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  getShadowLibraries(): ShadowLibrary[] {
    const rows = this.stmtGetAll.all() as ShadowLibraryRow[];
    return rows.map(this._rowToShadowLibrary);
  }

  getShadowLibraryById(id: number): ShadowLibrary | undefined {
    const row = this.stmtGetById.get(id) as ShadowLibraryRow | undefined;
    return row ? this._rowToShadowLibrary(row) : undefined;
  }

  createShadowLibrary(
    name: string,
    libPath: string,
    codecConfigId: number
  ): number {
    if (!name?.trim()) throw new Error("Shadow library name is required");
    if (!libPath?.trim()) throw new Error("Shadow library path is required");

    const resolvedPath = path.resolve(libPath);
    fs.mkdirSync(resolvedPath, { recursive: true });

    const info = this.stmtInsert.run(name.trim(), resolvedPath, codecConfigId);
    return Number(info.lastInsertRowid);
  }

  deleteShadowLibrary(id: number, removeFiles = true): boolean {
    const lib = this.getShadowLibraryById(id);
    if (!lib) return false;

    if (removeFiles) {
      const tracks = this.stmtGetShadowTracksByLib.all(id) as ShadowTrackRow[];
      for (const t of tracks) {
        try {
          if (fs.existsSync(t.shadow_path)) fs.unlinkSync(t.shadow_path);
        } catch { /* best effort */ }
      }
      this._cleanEmptyDirs(lib.path);
    }

    this.stmtDelete.run(id);
    return true;
  }

  // ------------------------------------------------------------------
  // Build
  // ------------------------------------------------------------------

  /**
   * Transcode every primary-library track into the shadow library.
   *
   * Long-running; supports progress callbacks and AbortSignal cancellation.
   */
  async buildShadowLibrary(
    shadowLibId: number,
    allTracks: Track[],
    libraryFolderPaths: Map<number, string>,
    progressCallback?: (progress: ShadowBuildProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const lib = this.getShadowLibraryById(shadowLibId);
    if (!lib) throw new Error(`Shadow library ${shadowLibId} not found`);

    const codecConfig = this.stmtGetCodecConfig.get(
      lib.codecConfigId
    ) as CodecConfigRow | undefined;
    if (!codecConfig) throw new Error("Codec configuration not found");

    this.stmtSetStatus.run("building", shadowLibId);
    const total = allTracks.length;

    const settings = this._buildConversionSettings(codecConfig);

    let converted = 0;
    let skipped = 0;
    let errors = 0;

    const yieldEventLoop = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));

    for (let i = 0; i < allTracks.length; i++) {
      await yieldEventLoop();

      if (signal?.aborted) {
        this.stmtSetStatus.run("ready", shadowLibId);
        progressCallback?.({
          shadowLibraryId: shadowLibId,
          processed: i,
          total,
          currentFile: "",
          status: "cancelled",
          logMessage: `Build cancelled (${converted} converted, ${skipped} skipped, ${errors} errors)`,
          logLevel: "info",
        });
        return;
      }

      const track = allTracks[i];

      progressCallback?.({
        shadowLibraryId: shadowLibId,
        processed: i,
        total,
        currentFile: track.filename,
        status: "building",
        logMessage: `Converting: ${track.filename}`,
        logLevel: "info",
      });

      let lastLogTime = 0;
      const LOG_THROTTLE_MS = 200;
      const logCallback = progressCallback
        ? (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const now = Date.now();
            const isError = /error|failed|invalid/i.test(trimmed);
            const throttleOk = now - lastLogTime >= LOG_THROTTLE_MS;
            if (isError || throttleOk) {
              lastLogTime = now;
              progressCallback({
                shadowLibraryId: shadowLibId,
                processed: i,
                total,
                currentFile: track.filename,
                status: "building",
                logMessage: trimmed,
                logLevel: isError ? "error" : "info",
              });
            }
          }
        : undefined;

      try {
        const result = await this._transcodeTrack(
          track,
          lib,
          codecConfig,
          settings,
          libraryFolderPaths,
          signal,
          logCallback
        );

        if (result === "skipped") {
          skipped++;
          progressCallback?.({
            shadowLibraryId: shadowLibId,
            processed: i + 1,
            total,
            currentFile: track.filename,
            status: "building",
            logMessage: `Skipped (already exists): ${track.filename}`,
            logLevel: "skip",
          });
        } else {
          converted++;
          progressCallback?.({
            shadowLibraryId: shadowLibId,
            processed: i + 1,
            total,
            currentFile: track.filename,
            status: "building",
            logMessage: `Converted: ${track.filename}`,
            logLevel: "success",
          });
        }
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        this.stmtInsertTrack.run(
          shadowLibId,
          track.id,
          "",
          "error",
          msg
        );
        progressCallback?.({
          shadowLibraryId: shadowLibId,
          processed: i + 1,
          total,
          currentFile: track.filename,
          status: "building",
          logMessage: `Error: ${track.filename} — ${msg}`,
          logLevel: "error",
        });
      }
    }

    const hasErrors = errors > 0;
    this.stmtSetStatus.run(hasErrors ? "error" : "ready", shadowLibId);
    progressCallback?.({
      shadowLibraryId: shadowLibId,
      processed: total,
      total,
      currentFile: "",
      status: hasErrors ? "error" : "complete",
      logMessage: hasErrors
        ? `Build failed — ${converted} converted, ${skipped} skipped, ${errors} errors`
        : `Build complete — ${converted} converted, ${skipped} skipped, ${errors} errors`,
      logLevel: hasErrors ? "error" : "info",
    });
  }

  // ------------------------------------------------------------------
  // Propagation
  // ------------------------------------------------------------------

  /**
   * Propagate newly added or updated tracks to all ready shadow libraries.
   */
  async propagateAddedOrUpdated(
    trackPaths: string[],
    getTrackByPath: (p: string) => Track | undefined,
    libraryFolderPaths: Map<number, string>,
    signal?: AbortSignal
  ): Promise<void> {
    const libs = this.getShadowLibraries().filter(
      (l) => l.status === "ready"
    );
    if (libs.length === 0 || trackPaths.length === 0) return;

    for (const lib of libs) {
      const codecConfig = this.stmtGetCodecConfig.get(
        lib.codecConfigId
      ) as CodecConfigRow | undefined;
      if (!codecConfig) continue;
      const settings = this._buildConversionSettings(codecConfig);

      for (const tp of trackPaths) {
        if (signal?.aborted) return;
        const track = getTrackByPath(tp);
        if (!track) continue;

        try {
          await this._transcodeTrack(
            track,
            lib,
            codecConfig,
            settings,
            libraryFolderPaths,
            signal
          );
        } catch { /* logged at track level */ }
      }
    }
  }

  /**
   * Remove shadow copies when primary tracks are deleted.
   */
  propagateRemovedByPath(trackPaths: string[]): void {
    if (trackPaths.length === 0) return;

    const libs = this.getShadowLibraries();
    if (libs.length === 0) return;

    const trackIds = this.db
      .prepare(
        `SELECT id, path FROM tracks WHERE path IN (${
          trackPaths.map(() => "?").join(",")
        })`
      )
      .all(...trackPaths) as { id: number; path: string }[];

    const idSet = new Set(trackIds.map((t) => t.id));
    this.propagateRemovedByIds([...idSet]);
  }

  /**
   * Remove shadow copies by source track IDs from all shadow libraries.
   */
  propagateRemovedByIds(trackIds: number[]): void {
    if (trackIds.length === 0) return;
    const libs = this.getShadowLibraries();

    for (const lib of libs) {
      for (const trackId of trackIds) {
        const st = this.stmtGetTrackBySource.get(
          lib.id,
          trackId
        ) as ShadowTrackRow | undefined;
        if (!st) continue;

        try {
          if (st.shadow_path && fs.existsSync(st.shadow_path)) {
            fs.unlinkSync(st.shadow_path);
          }
        } catch { /* best effort */ }

        this.stmtDeleteTrackBySource.run(lib.id, trackId);
      }
    }
  }

  /**
   * Look up shadow track paths for a given shadow library, keyed by
   * source track ID.
   */
  getShadowTrackMap(
    shadowLibId: number
  ): Map<number, string> {
    const rows = this.stmtGetShadowTracksByLib.all(
      shadowLibId
    ) as ShadowTrackRow[];
    const map = new Map<number, string>();
    for (const r of rows) {
      if (r.status === "synced") {
        map.set(r.source_track_id, r.shadow_path);
      }
    }
    return map;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private async _transcodeTrack(
    track: Track,
    lib: ShadowLibrary,
    codecConfig: CodecConfigRow,
    settings: ConversionSettings,
    libraryFolderPaths: Map<number, string>,
    signal?: AbortSignal,
    logCallback?: (line: string) => void
  ): Promise<"converted" | "skipped"> {
    const relPath = this._computeShadowRelPath(
      track,
      codecConfig,
      libraryFolderPaths
    );
    const destPath = path.join(lib.path, relPath);

    const existing = this.stmtGetTrackBySource.get(
      lib.id,
      track.id
    ) as ShadowTrackRow | undefined;
    if (
      existing?.status === "synced" &&
      existing.shadow_path === destPath &&
      fs.existsSync(destPath)
    ) {
      return "skipped";
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const ok = await convertWithCodec(
      track.path,
      destPath,
      settings,
      logCallback,
      signal
    );

    if (ok) {
      this.stmtInsertTrack.run(
        lib.id,
        track.id,
        destPath,
        "synced",
        null
      );
      return "converted";
    } else {
      this.stmtInsertTrack.run(
        lib.id,
        track.id,
        destPath,
        "error",
        "Conversion failed"
      );
      throw new Error("Conversion failed");
    }
  }

  private _computeShadowRelPath(
    track: Track,
    codecConfig: CodecConfigRow,
    libraryFolderPaths: Map<number, string>
  ): string {
    const basePath = libraryFolderPaths.get(track.libraryFolderId);
    let relPath: string;
    if (basePath && track.path.startsWith(basePath)) {
      relPath = track.path.slice(basePath.length).replace(/^[/\\]+/, "");
    } else {
      relPath = track.filename;
    }

    const codecLower = codecConfig.codec_name.toLowerCase();
    return updateExtension(relPath, codecLower);
  }

  private _buildConversionSettings(
    codecConfig: CodecConfigRow
  ): ConversionSettings {
    const codec = codecConfig.codec_name.toLowerCase();
    const settings: ConversionSettings = {
      codec,
      transfer_mode: "convert",
    };

    if (codecConfig.bitrate_value != null) {
      settings.bitrate = codecConfig.bitrate_value;
    }
    if (codecConfig.quality_value != null) {
      settings.quality = codecConfig.quality_value;
      if (codec === "mpc") {
        settings.bitrate = codecConfig.quality_value;
      }
    }

    return settings;
  }

  private _rowToShadowLibrary(row: ShadowLibraryRow): ShadowLibrary {
    const totalBytes = computeDirectorySize(row.path);
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      codecConfigId: row.codec_config_id,
      codecConfigName: row.codec_config_name,
      codecName: row.codec_name,
      codecBitrateValue: row.bitrate_value ?? null,
      codecQualityValue: row.quality_value ?? null,
      codecBitsPerSample: row.bits_per_sample ?? null,
      totalBytes,
      status: row.status as ShadowLibrary["status"],
      trackCount: row.track_count,
      createdAt: row.created_at,
    };
  }
}
