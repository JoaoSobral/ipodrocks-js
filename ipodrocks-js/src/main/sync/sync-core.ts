import * as fs from "fs";
import * as path from "path";

import { Track } from "../../shared/types";
import { Device } from "../devices/device";
import {
  CompareOptions,
  CompareResult,
  SkippedTrack,
  compareLibraries,
} from "./name-size-sync";
import { ConversionSettings, updateExtension, estimateConvertedSize } from "./sync-conversion";
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
  /** When true, do not copy album artwork (*.jpg, *.png) to device. */
  skipAlbumArtwork?: boolean;
  /** F7: Pre-loaded path→mtime from content_hashes to avoid per-track fs.statSync. */
  preloadedMtimes?: Map<string, number>;
}

export interface ContentAnalysis {
  libraryTracks: Record<string, Record<string, unknown>>;
  deviceTracks: Record<string, { file_size: number }>;
  missingPaths: string[];
  extras: string[];
  codecMismatchPaths: string[];
  codecMismatchMap: Map<string, string>;
}

const FAT32_INVALID = /[\\/:*?"<>|]/g;

/**
 * Recursively removes empty directories under rootDir (post-order traversal).
 * Best-effort; ignores errors.
 */
export function cleanEmptyDirectories(rootDir: string): void {
  if (!fs.existsSync(rootDir)) return;
  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        cleanEmptyDirectories(path.join(rootDir, entry.name));
      }
    }
    const remaining = fs.readdirSync(rootDir);
    if (remaining.length === 0) {
      fs.rmdirSync(rootDir);
    }
  } catch {
    /* best effort */
  }
}

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
  progressCallback?: ProgressCallback,
  /** F7: Pre-loaded path→mtime map from content_hashes. Falls back to fs.statSync on miss. */
  preloadedMtimes?: Map<string, number>
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
  const codecCategory = classifyCodecCategory(codecLower);

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
      const originalSize =
        (trackInfo.fileSize as number) ??
        (trackInfo.file_size as number) ??
        0;

      if (codecCategory === "lossless" && originalSize > 0) {
        // For lossless conversions (e.g. FLAC → ALAC) keep a heuristic
        // expected size so we can detect codec changes via large size deltas.
        const assumedBitrate = 256;
        expectedSizes[trackPath] = estimateConvertedSize(
          originalSize,
          codecLower,
          assumedBitrate
        );
      } else {
        // For lossy conversions (e.g. ALAC → AAC/MPC/MP3) the relationship
        // between source size and encoded size is too noisy to use as a
        // reliable equality check, so we ignore size when deciding whether
        // a device file is up to date.
        expectedSizes[trackPath] = 0;
      }
    } else {
      expectedSizes[trackPath] =
        (trackInfo.fileSize as number) ?? (trackInfo.file_size as number) ?? 0;
    }

    // F7: Use pre-loaded mtime from DB cache; fall back to fs.statSync only on miss.
    // This avoids 10k+ synchronous syscalls for large libraries.
    const cachedMtime = preloadedMtimes?.get(trackPath);
    if (cachedMtime != null) {
      expectedMtimes[trackPath] = cachedMtime;
    } else {
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

function classifyCodecCategory(codecName: string): "lossless" | "lossy" | "unknown" {
  const lower = codecName.toLowerCase();
  if (["alac", "flac", "pcm"].includes(lower)) return "lossless";
  if (["aac", "mp3", "ogg", "opus", "mpc"].includes(lower)) return "lossy";
  return "unknown";
}

function classifyDeviceCodecFromSamples(
  samples: SkippedTrack[],
  libraryTracks: Record<string, Record<string, unknown>>,
  deviceFilesMap: Record<string, { file_size: number; mtime?: number }>
): "lossless" | "lossy" | "unknown" {
  const ratios: number[] = [];
  const maxSamples = 5;

  for (const s of samples) {
    if (ratios.length >= maxSamples) break;
    const libInfo = libraryTracks[s.library_path];
    const devInfo = deviceFilesMap[s.device_path];
    if (!libInfo || !devInfo) continue;

    const libSize =
      (libInfo.fileSize as number) ??
      (libInfo.file_size as number) ??
      0;
    const devSize = devInfo.file_size ?? 0;
    if (libSize <= 0 || devSize <= 0) continue;

    const ratio = devSize / libSize;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    ratios.push(ratio);
  }

  if (ratios.length === 0) return "unknown";

  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  if (avg >= 0.5) return "lossless";
  if (avg <= 0.4) return "lossy";
  return "unknown";
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
  /** F7: Pre-loaded path→mtime from content_hashes, passed through to buildLibraryDestMap. */
  preloadedMtimes?: Map<string, number>
): ContentAnalysis {
  if (cancelSignal?.aborted) throw new SyncCancelled();

  const { destMap, expectedSizes, expectedMtimes } = buildLibraryDestMap(
    libraryTracks,
    contentType,
    codecName,
    libraryFolderPaths,
    cancelSignal,
    progressCallback,
    preloadedMtimes
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

  let { missingTracks, tracksToSkip } = result;

  if (
    missingTracks.size === 0 &&
    Object.keys(libraryTracks).length > 0 &&
    Object.keys(deviceFilesMap).length > 0 &&
    tracksToSkip.length > 0
  ) {
    const targetCategory = classifyCodecCategory(codecName);
    const deviceCategory = classifyDeviceCodecFromSamples(
      tracksToSkip,
      libraryTracks,
      deviceFilesMap
    );

    if (
      targetCategory !== "unknown" &&
      deviceCategory !== "unknown" &&
      targetCategory !== deviceCategory
    ) {
      progressCallback?.({
        event: "log",
        message: `Detected codec mismatch between device files (${deviceCategory}) and target profile (${targetCategory}); forcing full resync for this content type.`,
      });
      missingTracks = new Set(Object.keys(libraryTracks));
    }
  }

  if (
    missingTracks.size === 0 &&
    Object.keys(libraryTracks).length > 0 &&
    Object.keys(deviceFilesMap).length === 0
  ) {
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
    codecMismatchMap: result.codecMismatchMap,
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
  cancelSignal?: AbortSignal,
  deviceProfile?: { codecConfigBitrate?: number | null; codecConfigQuality?: number | null },
  codecMismatchMap?: Map<string, string>
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
  const perTrackConversion: Record<string, ConversionSettings> = {};

  const needsConversion = !["DIRECT COPY", "COPY", "NONE"].includes(codecName.toUpperCase());
  const codecLower = needsConversion ? codecName.toLowerCase() : "copy";
  const isMpc = codecLower === "mpc";
  const bitrate = deviceProfile?.codecConfigBitrate ?? 256;
  const quality = deviceProfile?.codecConfigQuality ?? (isMpc ? 7 : undefined);

  for (const tp of existingPaths) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    const trackInfo = libraryTracks[tp] ?? {};
    const existingDeviceRel = codecMismatchMap?.get(tp);
    if (existingDeviceRel && needsConversion) {
      customDestinations[tp] = updateExtension(existingDeviceRel, codecLower);
    } else {
      customDestinations[tp] = computeDeviceRelativePath(
        tp,
        trackInfo,
        contentType,
        libraryFolderPaths
      );
    }

    if (needsConversion) {
      perTrackConversion[tp] = {
        transfer_mode: "convert",
        codec: codecLower,
        bitrate: isMpc ? undefined : bitrate,
        quality: isMpc ? quality : undefined,
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
    perTrackConversion,
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

const ARTWORK_EXTENSIONS = [".jpg", ".jpeg", ".png"];

export interface ArtworkSyncResult {
  copied: number;
  skipped: number;
  errors: number;
  totalCandidates: number;
}

/**
 * Copy album artwork (*.jpg, *.png) from source album folders to device.
 * Skips unchanged files using size/mtime checks. Uses the same folder
 * structure as tracks (Artist/Album).
 */
export function copyAlbumArtworkToDevice(
  deviceContentPath: string,
  contentType: string,
  libraryTracks: Record<string, Record<string, unknown>>,
  libraryFolderPaths?: Map<number, string>,
  progressCallback?: ProgressCallback,
  cancelSignal?: AbortSignal
): ArtworkSyncResult {
  if (Object.keys(libraryTracks).length === 0) {
    return { copied: 0, skipped: 0, errors: 0, totalCandidates: 0 };
  }

  const sourceToDeviceRel = new Map<string, string>();

  for (const [trackPath, trackInfo] of Object.entries(libraryTracks)) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    const sourceDir = path.dirname(trackPath);
    if (sourceToDeviceRel.has(sourceDir)) continue;

    const relPath = computeDeviceRelativePath(
      trackPath,
      trackInfo,
      contentType,
      libraryFolderPaths
    );
    const deviceRelAlbum = path.dirname(relPath).replace(/\\/g, "/");
    sourceToDeviceRel.set(sourceDir, deviceRelAlbum);
  }

  const candidates: { srcPath: string; destPath: string }[] = [];

  for (const [sourceDir, deviceRelAlbum] of sourceToDeviceRel) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ARTWORK_EXTENSIONS.includes(ext)) continue;

      const srcPath = path.join(sourceDir, entry.name);
      const destPath = path.join(
        deviceContentPath,
        deviceRelAlbum,
        entry.name
      );
      candidates.push({ srcPath, destPath });
    }
  }

  if (candidates.length > 0) {
    progressCallback?.({
      event: "total_add",
      path: String(candidates.length),
    });
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;

  for (const { srcPath, destPath } of candidates) {
    if (cancelSignal?.aborted) throw new SyncCancelled();

    let srcStat: fs.Stats;
    try {
      srcStat = fs.statSync(srcPath);
    } catch {
      errors++;
      progressCallback?.({
        event: "copy",
        path: srcPath,
        destination: destPath,
        status: "error",
        contentType: "artwork",
      });
      continue;
    }

    let destStat: fs.Stats | null = null;
    try {
      destStat = fs.statSync(destPath);
    } catch {
      /* destination missing, will copy */
    }

    if (destStat?.isFile()) {
      const sizeMatch = destStat.size === srcStat.size;
      if (sizeMatch) {
        skipped++;
        progressCallback?.({
          event: "copy",
          path: srcPath,
          destination: destPath,
          status: "skipped",
          contentType: "artwork",
        });
        continue;
      }
    }

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied++;
      progressCallback?.({
        event: "log",
        message: `Artwork copied: ${path.basename(destPath)}`,
      });
      progressCallback?.({
        event: "copy",
        path: destPath,
        destination: destPath,
        status: "copied",
        contentType: "artwork",
      });
    } catch {
      errors++;
      progressCallback?.({
        event: "copy",
        path: srcPath,
        destination: destPath,
        status: "error",
        contentType: "artwork",
      });
    }
  }

  return {
    copied,
    skipped,
    errors,
    totalCandidates: candidates.length,
  };
}

/**
 * Compute the relative path of a source directory within its library folder.
 * Used to mirror folder structure when copying artwork to shadow libraries.
 */
function computeShadowAlbumRelPath(
  sourceDir: string,
  libraryFolderPaths: Map<number, string>,
  libraryFolderId: number
): string {
  const basePath = libraryFolderPaths.get(libraryFolderId);
  if (!basePath) return "";
  const baseResolved = path.resolve(basePath);
  const sourceResolved = path.resolve(sourceDir);
  if (
    sourceResolved !== baseResolved &&
    !sourceResolved.startsWith(baseResolved + path.sep)
  ) {
    return "";
  }
  const rel = path.relative(basePath, sourceDir).replace(/\\/g, "/");
  return rel || "";
}

/**
 * Copy album artwork (*.jpg, *.jpeg, *.png) from source library folders to a
 * shadow library root, mirroring the folder structure. Used for all shadow
 * libraries regardless of codec.
 */
export function copyArtworkToShadowLibrary(
  allTracks: Track[],
  libraryFolderPaths: Map<number, string>,
  shadowRoot: string,
  progressCallback?: (msg: string) => void,
  signal?: AbortSignal
): ArtworkSyncResult {
  if (allTracks.length === 0) {
    return { copied: 0, skipped: 0, errors: 0, totalCandidates: 0 };
  }

  const sourceDirToRel = new Map<string, string>();

  for (const track of allTracks) {
    if (signal?.aborted) throw new SyncCancelled();
    const sourceDir = path.dirname(track.path);
    if (sourceDirToRel.has(sourceDir)) continue;

    const albumRel = computeShadowAlbumRelPath(
      sourceDir,
      libraryFolderPaths,
      track.libraryFolderId
    );
    sourceDirToRel.set(sourceDir, albumRel);
  }

  const candidates: { srcPath: string; destPath: string }[] = [];

  for (const [sourceDir, albumRel] of sourceDirToRel) {
    if (signal?.aborted) throw new SyncCancelled();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch {
      progressCallback?.(
        `Could not read album directory for artwork: ${sourceDir}`
      );
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ARTWORK_EXTENSIONS.includes(ext)) continue;

      const srcPath = path.join(sourceDir, entry.name);
      const destPath = path.join(shadowRoot, albumRel, entry.name);
      candidates.push({ srcPath, destPath });
    }
  }

  if (
    sourceDirToRel.size > 0 &&
    candidates.length === 0 &&
    progressCallback
  ) {
    progressCallback(
      "No cover.jpg/cover.png/cover.jpeg found in any album folder."
    );
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;

  for (const { srcPath, destPath } of candidates) {
    if (signal?.aborted) throw new SyncCancelled();

    let srcStat: fs.Stats;
    try {
      srcStat = fs.statSync(srcPath);
    } catch {
      errors++;
      continue;
    }

    let destStat: fs.Stats | null = null;
    try {
      destStat = fs.statSync(destPath);
    } catch {
      /* destination missing, will copy */
    }

    if (destStat?.isFile() && destStat.size === srcStat.size) {
      skipped++;
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
      copied++;
      progressCallback?.(`Artwork copied: ${path.basename(destPath)}`);
    } catch {
      errors++;
    }
  }

  return {
    copied,
    skipped,
    errors,
    totalCandidates: candidates.length,
  };
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
  const { extraTrackPolicy, progressCallback, cancelSignal, skipAlbumArtwork, preloadedMtimes } =
    options;

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
    preloadedMtimes
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

  if (analysis.codecMismatchPaths.length > 0) {
    const { removed } = removeExtraTracks(
      analysis.codecMismatchPaths,
      progressCallback,
      cancelSignal
    );
    removedCount += removed;
    if (removed > 0) {
      progressCallback?.({
        event: "log",
        message: `Removed ${removed} old-codec file(s) to be replaced by new format`,
      });
    }
  }

  if (toSync > 0) {
    progressCallback?.({ event: "log", message: `Copying ${toSync} track(s) to device...` });
  }

  let { synced, missingFiles, errors } = await copyMissingTracks(
    deviceContentPath,
    contentType,
    analysis.missingPaths,
    analysis.libraryTracks,
    codecName,
    libraryFolderPaths,
    progressCallback,
    cancelSignal,
    device.profile,
    analysis.codecMismatchMap
  );

  if (skipAlbumArtwork !== true && Object.keys(libraryTracks).length > 0) {
    const artworkResult = copyAlbumArtworkToDevice(
      deviceContentPath,
      contentType,
      libraryTracks,
      libraryFolderPaths,
      progressCallback,
      cancelSignal
    );
    errors += artworkResult.errors;
    if (
      artworkResult.copied > 0 ||
      artworkResult.skipped > 0 ||
      artworkResult.errors > 0
    ) {
      const parts: string[] = [];
      if (artworkResult.copied > 0) {
        parts.push(`${artworkResult.copied} copied`);
      }
      if (artworkResult.skipped > 0) {
        parts.push(`${artworkResult.skipped} skipped`);
      }
      if (artworkResult.errors > 0) {
        parts.push(`${artworkResult.errors} error(s)`);
      }
      progressCallback?.({
        event: "log",
        message: `Album artwork: ${parts.join(", ")}.`,
      });
    }
  }

  if (removedCount > 0) {
    cleanEmptyDirectories(deviceContentPath);
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
