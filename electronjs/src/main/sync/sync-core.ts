import * as fs from "fs";
import * as path from "path";

import { Device, Track } from "../../shared/types";
import {
  CompareOptions,
  CompareResult,
  compareLibraries,
} from "./name-size-sync";
import { updateExtension } from "./sync-conversion";
import {
  CopyProgress,
  CopyToDeviceOptions,
  copyToDevice,
} from "./sync-executor";

export class SyncCancelled extends Error {
  constructor() {
    super("Sync cancelled by user.");
  }
}

export interface SyncProgressEvent {
  event: string;
  [key: string]: unknown;
}

export type ProgressCallback = (event: SyncProgressEvent) => void;

export interface RunSyncOptions {
  syncType?: string;
  extraTrackPolicy?: string | null;
  includePodcasts?: boolean;
  includeAudiobooks?: boolean;
  includePlaylists?: boolean;
  progressCallback?: ProgressCallback;
  cancelSignal?: AbortSignal;
  ignoreSpaceCheck?: boolean;
  /** When true, compare step emits [SYNC-DIAG] / [ORPHAN-DIAG] to progressCallback (e.g. --dev). */
  enableSyncDiagnostics?: boolean;
}

export interface ContentAnalysis {
  libraryTracks: Record<string, Record<string, unknown>>;
  deviceTracks: Record<string, { file_size: number }>;
  missingPaths: string[];
  extras: string[];
  codecMismatchPaths: string[];
}

const FAT32_INVALID = /[\\/:*?"<>|]/g;

export function sanitizeDevicePathComponent(
  component: string,
  maxLen = 255
): string {
  if (!component) return "_";
  let out = component.replace(FAT32_INVALID, "_");
  out = out.replace(/^[\s.]+|[\s.]+$/g, "");
  if (!out) return "_";
  return out.length > maxLen ? out.slice(0, maxLen) : out;
}

export function computeDeviceRelativePath(
  trackPath: string,
  trackInfo: Record<string, unknown>,
  contentType: string,
  libraryFolderPaths?: Map<number, string>
): string {
  const artist = ((trackInfo.artist as string) ?? "").trim();
  const album = ((trackInfo.album as string) ?? "").trim();
  const filename = path.basename(trackPath);

  if (
    artist &&
    artist !== "Unknown Artist" &&
    album &&
    album !== "Unknown Album"
  ) {
    const safeArtist = sanitizeDevicePathComponent(artist);
    const safeAlbum = sanitizeDevicePathComponent(album);
    const safeFilename = sanitizeDevicePathComponent(filename);
    return path.posix.join(safeArtist, safeAlbum, safeFilename);
  }

  const folderId = trackInfo.libraryFolderId as number | undefined;
  if (folderId != null && libraryFolderPaths) {
    const basePath = libraryFolderPaths.get(folderId);
    if (basePath) {
      const resolved = path.resolve(trackPath);
      const baseResolved = path.resolve(basePath);
      if (resolved.startsWith(baseResolved + path.sep) || resolved.startsWith(baseResolved + "/")) {
        let rel = resolved.slice(baseResolved.length + 1).replace(/\\/g, "/");
        const parts = rel.split("/");
        const folderNames =
          contentType === "music"
            ? ["Music", "music", "MUSIC"]
            : contentType === "audiobook"
              ? ["Audiobooks", "audiobooks", "AUDIOBOOKS", "Audiobook", "audiobook"]
              : ["Podcasts", "podcasts", "PODCASTS", "Podcast", "podcast"];

        if (parts.length > 1 && folderNames.includes(parts[0])) {
          const safeParts = parts.slice(1).map((p) => sanitizeDevicePathComponent(p));
          return safeParts.join("/");
        }
        if (parts.length === 1 && folderNames.includes(parts[0])) {
          return sanitizeDevicePathComponent(filename);
        }

        const relParts = rel.split("/");
        if (relParts.length <= 2) {
          const baseName = path.basename(basePath);
          if (!folderNames.includes(baseName)) {
            return path.posix.join(sanitizeDevicePathComponent(baseName), ...relParts.map(sanitizeDevicePathComponent));
          }
        }
        return relParts.map(sanitizeDevicePathComponent).join("/");
      }
    }
  }

  return sanitizeDevicePathComponent(filename);
}

export function buildLibraryDestMap(
  libraryTracks: Record<string, Record<string, unknown>>,
  contentType: string,
  codecName: string,
  libraryFolderPaths?: Map<number, string>,
  cancelSignal?: AbortSignal,
  progressCallback?: ProgressCallback
): {
  destMap: Record<string, string>;
  expectedSizes: Record<string, number>;
  expectedMtimes: Record<string, number>;
} {
  const destMap: Record<string, string> = {};
  const expectedSizes: Record<string, number> = {};
  const expectedMtimes: Record<string, number> = {};

  const needsConversion = !["DIRECT COPY", "COPY", "NONE"].includes(
    codecName.toUpperCase()
  );
  const codecLower = needsConversion ? codecName.toLowerCase() : "copy";

  const entries = Object.entries(libraryTracks);
  const total = entries.length;

  for (let i = 0; i < entries.length; i++) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    if (progressCallback && i % 200 === 0 && total > 0) {
      progressCallback({ event: "compare", current: i, total });
    }

    const [trackPath, trackInfo] = entries[i];
    let relPath = computeDeviceRelativePath(
      trackPath,
      trackInfo,
      contentType,
      libraryFolderPaths
    );

    if (needsConversion) {
      relPath = updateExtension(relPath, codecLower);
      expectedSizes[trackPath] = 0;
    } else {
      expectedSizes[trackPath] =
        (trackInfo.fileSize as number) ?? (trackInfo.file_size as number) ?? 0;
      try {
        expectedMtimes[trackPath] = fs.statSync(trackPath).mtimeMs;
      } catch {
        // leave unset
      }
    }

    destMap[trackPath] = relPath.replace(/\\/g, "/");
  }

  return { destMap, expectedSizes, expectedMtimes };
}

export function getProfileCodecExt(codecName: string): string | null {
  const upper = codecName.toUpperCase();
  if (["DIRECT COPY", "COPY", "NONE"].includes(upper)) return null;
  const ext = path.extname(updateExtension("x", codecName.toLowerCase()));
  return ext || null;
}

export function analyzeContentType(
  deviceFilesMap: Record<string, { file_size: number; mtime?: number }>,
  deviceContentPath: string,
  libraryTracks: Record<string, Record<string, unknown>>,
  contentType: string,
  codecName: string,
  libraryFolderPaths?: Map<number, string>,
  cancelSignal?: AbortSignal,
  progressCallback?: ProgressCallback,
  enableSyncDiagnostics?: boolean
): ContentAnalysis {
  if (cancelSignal?.aborted) throw new SyncCancelled();

  const { destMap, expectedSizes, expectedMtimes } = buildLibraryDestMap(
    libraryTracks,
    contentType,
    codecName,
    libraryFolderPaths,
    cancelSignal,
    progressCallback
  );

  if (cancelSignal?.aborted) throw new SyncCancelled();

  const profileCodecExt = getProfileCodecExt(codecName);
  const libCount = Object.keys(destMap).length;

  const compareOpts: CompareOptions = {
    libraryExpectedMtimes: expectedMtimes,
    cancelCallback: () => cancelSignal?.aborted ?? false,
    profileCodecExt,
    progressCallback: (current, total) => {
      progressCallback?.({
        event: "compare",
        current: libCount + current,
        total: libCount + total,
      });
    },
    ...(enableSyncDiagnostics && {
      debugCallback: (msg: string) => {
        progressCallback?.({ event: "log", message: msg });
      },
    }),
  };

  let result: CompareResult;
  try {
    result = compareLibraries(
      destMap,
      expectedSizes,
      deviceContentPath,
      deviceFilesMap,
      compareOpts
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cancelled")) {
      throw new SyncCancelled();
    }
    throw err;
  }

  let { missingTracks } = result;
  if (missingTracks.size === 0 && Object.keys(libraryTracks).length > 0 && Object.keys(deviceFilesMap).length === 0) {
    missingTracks = new Set(Object.keys(libraryTracks));
  }

  return {
    libraryTracks,
    deviceTracks: Object.fromEntries(
      Object.entries(deviceFilesMap).map(([p, s]) => [p, { file_size: s.file_size ?? 0 }])
    ),
    missingPaths: [...missingTracks].sort(),
    extras: result.extras,
    codecMismatchPaths: result.codecMismatchPaths,
  };
}

export async function copyMissingTracks(
  deviceContentPath: string,
  contentType: string,
  missingPaths: string[],
  libraryTracks: Record<string, Record<string, unknown>>,
  codecName: string,
  libraryFolderPaths?: Map<number, string>,
  progressCallback?: ProgressCallback,
  cancelSignal?: AbortSignal
): Promise<{ synced: number; missingFiles: string[]; errors: number }> {
  if (!missingPaths.length) return { synced: 0, missingFiles: [], errors: 0 };

  const existingPaths: string[] = [];
  const missingFiles: string[] = [];
  for (const tp of missingPaths) {
    if (fs.existsSync(tp)) {
      existingPaths.push(tp);
    } else {
      missingFiles.push(tp);
      progressCallback?.({
        event: "copy",
        path: tp,
        destination: null,
        status: "missing_file",
        contentType,
      });
    }
  }
  if (!existingPaths.length) return { synced: 0, missingFiles, errors: 0 };

  const customDestinations: Record<string, string> = {};
  const perTrackConversion: Record<string, Record<string, unknown>> = {};

  const needsConversion = !["DIRECT COPY", "COPY", "NONE"].includes(codecName.toUpperCase());
  const codecLower = needsConversion ? codecName.toLowerCase() : "copy";

  for (const tp of existingPaths) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    const trackInfo = libraryTracks[tp] ?? {};
    customDestinations[tp] = computeDeviceRelativePath(tp, trackInfo, contentType, libraryFolderPaths);

    if (needsConversion) {
      perTrackConversion[tp] = {
        transfer_mode: "convert",
        codec: codecLower,
        bitrate: 256,
        rule_applied: "device_default",
      };
    } else {
      perTrackConversion[tp] = {
        transfer_mode: "copy",
        codec: "copy",
        bitrate: 0,
        rule_applied: "device_default",
      };
    }
  }

  const stats = { synced: 0, errors: 0 };

  const progressAdapter = (cp: CopyProgress): void => {
    if (cp.status === "copied" || cp.status === "converted") stats.synced++;
    else if (cp.status === "error") stats.errors++;
    progressCallback?.({
      event: "copy",
      path: cp.srcPath,
      destination: cp.destPath,
      status: cp.status,
      contentType,
    });
  };

  const opts: CopyToDeviceOptions = {
    convert: needsConversion,
    preserveStructure: false,
    perTrackConversion: perTrackConversion as Record<string, any>,
    customDestinations,
    progressCallback: progressAdapter,
    logCallback: (line: string) =>
      progressCallback?.({ event: "log", message: line }),
    cancelSignal,
  };

  await copyToDevice(existingPaths, deviceContentPath, opts);
  return { synced: stats.synced, missingFiles, errors: stats.errors };
}

export function removeExtraTracks(
  extraPaths: string[],
  progressCallback?: ProgressCallback,
  cancelSignal?: AbortSignal
): { removed: number; bytesRemoved: number } {
  let removed = 0;
  let bytesRemoved = 0;

  for (const p of extraPaths) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    let fileSize = 0;
    try {
      fileSize = fs.statSync(p).size;
    } catch { /* ignore */ }
    try {
      fs.unlinkSync(p);
      removed++;
      bytesRemoved += fileSize;
      progressCallback?.({ event: "remove", path: p, bytes: fileSize });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
  }
  return { removed, bytesRemoved };
}

export async function runSync(
  device: Device,
  libraryTracks: Record<string, Record<string, unknown>>,
  codecName: string,
  contentType: string,
  deviceContentPath: string,
  deviceFilesMap: Record<string, { file_size: number; mtime?: number }>,
  options: RunSyncOptions = {},
  libraryFolderPaths?: Map<number, string>
): Promise<{
  status: string;
  synced: number;
  removed: number;
  extras: string[];
  missingFiles: string[];
  errors: number;
}> {
  const { extraTrackPolicy, progressCallback, cancelSignal } = options;

  progressCallback?.({ event: "log", message: `Comparing library with device (${contentType})...` });

  const analysis = analyzeContentType(
    deviceFilesMap,
    deviceContentPath,
    libraryTracks,
    contentType,
    codecName,
    libraryFolderPaths,
    cancelSignal,
    progressCallback,
    options.enableSyncDiagnostics
  );

  progressCallback?.({
    event: "analysis",
    missing: analysis.missingPaths.length,
    extras: analysis.extras.length,
    codecMismatch: analysis.codecMismatchPaths.length,
  });

  const toSync = analysis.missingPaths.length;
  const alreadyOnDevice = Object.keys(libraryTracks).length - toSync;
  progressCallback?.({
    event: "log",
    message: `Found ${toSync} track(s) to sync, ${alreadyOnDevice} already on device. ${analysis.extras.length} extra file(s) on device.`,
  });

  progressCallback?.({
    event: "total",
    path: String(analysis.missingPaths.length),
  });

  let removedCount = 0;
  if (extraTrackPolicy === "remove" && analysis.extras.length > 0) {
    const { removed } = removeExtraTracks(analysis.extras, progressCallback, cancelSignal);
    removedCount = removed;
  }

  if (toSync > 0) {
    progressCallback?.({ event: "log", message: `Copying ${toSync} track(s) to device...` });
  }

  const { synced, missingFiles, errors } = await copyMissingTracks(
    deviceContentPath,
    contentType,
    analysis.missingPaths,
    analysis.libraryTracks,
    codecName,
    libraryFolderPaths,
    progressCallback,
    cancelSignal
  );

  if (analysis.codecMismatchPaths.length > 0 && synced > 0) {
    const { removed } = removeExtraTracks(analysis.codecMismatchPaths, progressCallback, cancelSignal);
    removedCount += removed;
    if (removed > 0) {
      progressCallback?.({
        event: "log",
        message: `Removed ${removed} old-codec file(s) replaced by new format`,
      });
    }
  }

  return {
    status: errors > 0 ? "error" : "completed",
    synced,
    removed: removedCount,
    extras: extraTrackPolicy !== "remove" ? analysis.extras : [],
    missingFiles,
    errors,
  };
}
