import * as fs from "fs";
import * as path from "path";

import { Track, SyncProgressEventName, AlbumGrouping } from "../../shared/types";
import { albumArtistOf } from "../../shared/album-label";
import { Device } from "../devices/device";
import {
  CompareOptions,
  CompareResult,
  SkippedTrack,
  compareLibraries,
} from "./name-size-sync";
import { ConversionSettings, updateExtension, estimateConvertedSize, isCancellationError } from "./sync-conversion";
import { findOnDisk } from "../utils/normalize-path";
import {
  CopyProgress,
  CopyToDeviceOptions,
  copyToDevice,
} from "./sync-executor";
import {
  DEFAULT_COVER_MAX_DIMENSION,
  findAlbumArtSource,
  generateRockboxCover,
} from "./rockbox-cover";

const PASSTHROUGH_CODECS = ["DIRECT COPY", "COPY", "NONE"] as const;

export class SyncCancelled extends Error {
  constructor() {
    super("Sync cancelled by user.");
  }
}

export interface SyncProgressPayload {
  event: SyncProgressEventName;
  [key: string]: unknown;
}

export type ProgressCallback = (event: SyncProgressPayload) => void;

export interface RunSyncOptions {
  syncType?: string;
  extraTrackPolicy?: string | null;
  includePodcasts?: boolean;
  includeAudiobooks?: boolean;
  includePlaylists?: boolean;
  progressCallback?: ProgressCallback;
  cancelSignal?: AbortSignal;
  /** When true, do not generate/copy album artwork to device. */
  skipAlbumArtwork?: boolean;
  /** Max dimension (px) for generated Rockbox cover.jpg. Defaults to 300. */
  artworkMaxDimension?: number;
  /** F7: Pre-loaded path→mtime from content_hashes to avoid per-track fs.statSync. */
  preloadedMtimes?: Map<string, number>;
  /** Override profile codec extension for compare (e.g. shadow library codec when codecName is DIRECT COPY). */
  profileCodecExtOverride?: string | null;
  /** Issue #82: mirror the source library folder structure 1:1 instead of rebuilding from tags. */
  preserveFolderStructure?: boolean;
  /** Issue #113: which artist keys the rebuilt device folder layout. */
  albumGrouping?: AlbumGrouping;
}

/**
 * How a track's destination path is built.
 *
 * Every pass that touches the device layout takes this same shape, and they all
 * have to be given the *same* values: comparing with one layout and copying
 * with another writes files to paths the compare never looked at, so the sync
 * re-copies the whole library on every run. Bundling the three settings into
 * one object is what makes a mismatch visible at the call site.
 */
export interface LayoutOptions {
  libraryFolderPaths?: Map<number, string>;
  /** Issue #82: mirror the source library folder structure 1:1 instead of rebuilding from tags. */
  preserveFolderStructure?: boolean;
  /** Issue #113: which artist keys the rebuilt device folder layout. */
  albumGrouping?: AlbumGrouping;
}

/** Cooperative cancellation and progress reporting for the long passes. */
export interface RunOptions {
  cancelSignal?: AbortSignal;
  progressCallback?: ProgressCallback;
}

export interface BuildDestMapOptions extends LayoutOptions, RunOptions {
  /** F7: Pre-loaded path→mtime map from content_hashes. Falls back to fs.statSync on miss. */
  preloadedMtimes?: Map<string, number>;
}

export interface AnalyzeContentTypeOptions extends BuildDestMapOptions {
  /** Override profile codec extension for compare (e.g. shadow library codec when codecName is DIRECT COPY). */
  profileCodecExtOverride?: string | null;
}

export interface CopyMissingTracksOptions extends LayoutOptions, RunOptions {
  deviceProfile?: {
    codecConfigBitrate?: number | null;
    codecConfigQuality?: number | null;
    vbrEnabled?: boolean;
  };
  codecMismatchMap?: Map<string, string>;
}

export interface CopyAlbumArtworkOptions extends LayoutOptions, RunOptions {
  /** Max dimension (px) for the generated cover. */
  maxDim?: number;
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
 * The subset of Node's `path` API that {@link folderRelativePath} needs. Lets
 * tests inject `path.win32` so Windows drive-root behaviour (issue #112) can be
 * asserted from POSIX CI.
 */
type PathFlavor = Pick<
  typeof path,
  "resolve" | "relative" | "isAbsolute" | "basename"
>;

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

/**
 * Build a device-relative path that mirrors the source library folder structure
 * (relative to the library root), preserving album folder names exactly (incl.
 * the year and parentheses). Returns null when the track does not resolve under
 * a known library folder, so callers can fall back to a tag-based path.
 *
 * Issue #112: containment is computed with `path.relative` rather than a
 * `startsWith(base + sep)` test. When the library root is a filesystem root the
 * resolved base already ends in a separator ("M:\\", "/"), so the old test
 * compared against a doubled separator, never matched, and mirroring silently
 * fell back to tag-based paths. `pathImpl` is injectable so Windows drive-root
 * behaviour can be regression-tested from POSIX CI with `path.win32`.
 */
export function folderRelativePath(
  trackPath: string,
  contentType: string,
  libraryFolderPaths?: Map<number, string>,
  folderId?: number,
  pathImpl: PathFlavor = path
): string | null {
  if (folderId == null || !libraryFolderPaths) return null;
  const basePath = libraryFolderPaths.get(folderId);
  if (!basePath) return null;

  const resolved = pathImpl.resolve(trackPath);
  const baseResolved = pathImpl.resolve(basePath);
  const relRaw = pathImpl.relative(baseResolved, resolved);
  if (!relRaw || relRaw.startsWith("..") || pathImpl.isAbsolute(relRaw)) {
    return null;
  }

  const rel = relRaw.replace(/\\/g, "/");
  const filename = pathImpl.basename(trackPath);
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

  if (parts.length <= 2) {
    // Issue #112: a filesystem/drive root ("M:\\", "/") has an empty basename,
    // which would sanitize to "_" and inject a junk folder. Skip the prepend.
    const baseName = pathImpl.basename(baseResolved);
    if (baseName && !folderNames.includes(baseName)) {
      return path.posix.join(
        sanitizeDevicePathComponent(baseName),
        ...parts.map((p) => sanitizeDevicePathComponent(p))
      );
    }
  }
  return parts.map((p) => sanitizeDevicePathComponent(p)).join("/");
}

export function computeDeviceRelativePath(
  trackPath: string,
  trackInfo: Record<string, unknown>,
  contentType: string,
  layout: LayoutOptions = {}
): string {
  const {
    libraryFolderPaths,
    preserveFolderStructure = false,
    albumGrouping = "album-artist",
  } = layout;
  // Issue #113: when rebuilding a path from tags, fold the album under its album
  // artist so a compilation lands in one folder instead of one per track artist.
  const artist = (
    albumGrouping === "track-artist"
      ? ((trackInfo.artist as string) ?? "")
      : albumArtistOf({
          artist: trackInfo.artist as string | undefined,
          albumArtist: trackInfo.albumArtist as string | undefined,
        })
  ).trim();
  const album = ((trackInfo.album as string) ?? "").trim();
  const filename = path.basename(trackPath);
  const folderId = trackInfo.libraryFolderId as number | undefined;
  const mirrored = folderRelativePath(
    trackPath,
    contentType,
    libraryFolderPaths,
    folderId
  );

  // Issue #82: when mirroring is enabled, preserve the source folder layout 1:1
  // (e.g. "Artist/Album (2011)/track.flac") instead of rebuilding from tags.
  if (preserveFolderStructure && mirrored) return mirrored;

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

  if (mirrored) return mirrored;

  return sanitizeDevicePathComponent(filename);
}

export function buildLibraryDestMap(
  libraryTracks: Record<string, Record<string, unknown>>,
  contentType: string,
  codecName: string,
  options: BuildDestMapOptions = {}
): {
  destMap: Record<string, string>;
  expectedSizes: Record<string, number>;
  expectedMtimes: Record<string, number>;
} {
  const { cancelSignal, progressCallback, preloadedMtimes } = options;
  const destMap: Record<string, string> = {};
  const expectedSizes: Record<string, number> = {};
  const expectedMtimes: Record<string, number> = {};

  const needsConversion = !(PASSTHROUGH_CODECS as readonly string[]).includes(
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
      options
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
  if ((PASSTHROUGH_CODECS as readonly string[]).includes(upper)) return null;
  const ext = path.extname(updateExtension("x", codecName.toLowerCase()));
  return ext || null;
}

export function analyzeContentType(
  deviceFilesMap: Record<string, { file_size: number; mtime?: number }>,
  deviceContentPath: string,
  libraryTracks: Record<string, Record<string, unknown>>,
  contentType: string,
  codecName: string,
  options: AnalyzeContentTypeOptions = {}
): ContentAnalysis {
  const {
    cancelSignal,
    progressCallback,
    profileCodecExtOverride,
    preserveFolderStructure = false,
  } = options;
  if (cancelSignal?.aborted) throw new SyncCancelled();

  const { destMap, expectedSizes, expectedMtimes } = buildLibraryDestMap(
    libraryTracks,
    contentType,
    codecName,
    options
  );

  if (cancelSignal?.aborted) throw new SyncCancelled();

  const profileCodecExt = profileCodecExtOverride ?? getProfileCodecExt(codecName);
  const libCount = Object.keys(destMap).length;

  const compareOpts: CompareOptions = {
    libraryExpectedMtimes: expectedMtimes,
    cancelCallback: () => cancelSignal?.aborted ?? false,
    profileCodecExt,
    preserveFolderStructure,
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
    if (isCancellationError(err)) {
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
  options: CopyMissingTracksOptions = {}
): Promise<{ synced: number; missingFiles: string[]; errors: number }> {
  const { progressCallback, cancelSignal, deviceProfile, codecMismatchMap } = options;
  if (!missingPaths.length) return { synced: 0, missingFiles: [], errors: 0 };

  const existingPaths: string[] = [];
  const missingFiles: string[] = [];
  for (const tp of missingPaths) {
    // Stored paths are NFC; the on-disk name may be NFD on normalization-
    // sensitive filesystems. Probe the resolved form but keep `tp` (NFC) as the
    // key for destination naming and progress/DB lookups — otherwise perfectly
    // present tracks get reported as missing and never reach copyToDevice,
    // which does its own findOnDisk.
    if (fs.existsSync(findOnDisk(tp))) {
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

  const needsConversion = !(PASSTHROUGH_CODECS as readonly string[]).includes(codecName.toUpperCase());
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
        options
      );
    }

    if (needsConversion) {
      perTrackConversion[tp] = {
        transfer_mode: "convert",
        codec: codecLower,
        bitrate: isMpc ? undefined : bitrate,
        quality: isMpc ? quality : undefined,
        vbr: !!deviceProfile?.vbrEnabled,
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
      progressCallback?.({ event: "convert_log", message: line }),
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

export interface ArtworkSyncResult {
  copied: number;
  skipped: number;
  errors: number;
  totalCandidates: number;
  /** Source album folders whose cover could not be generated. */
  failedAlbums: string[];
}

/**
 * Generate one Rockbox-compatible `cover.jpg` per album folder on the device.
 *
 * Rather than byte-copying every source image (progressive/oversized JPEGs load
 * inconsistently on Rockbox and slow the device down), this picks the best
 * source art per album — folder art or the first track's embedded picture — and
 * re-encodes it to a small baseline JPEG via ffmpeg. See sync/rockbox-cover.ts.
 */
export async function copyAlbumArtworkToDevice(
  deviceContentPath: string,
  contentType: string,
  libraryTracks: Record<string, Record<string, unknown>>,
  options: CopyAlbumArtworkOptions = {}
): Promise<ArtworkSyncResult> {
  const {
    progressCallback,
    cancelSignal,
    maxDim = DEFAULT_COVER_MAX_DIMENSION,
  } = options;
  if (Object.keys(libraryTracks).length === 0) {
    return { copied: 0, skipped: 0, errors: 0, totalCandidates: 0, failedAlbums: [] };
  }

  // Per album source dir: device-relative album folder + a representative track.
  const albums = new Map<string, { deviceRelAlbum: string; firstTrack: string }>();

  for (const [trackPath, trackInfo] of Object.entries(libraryTracks)) {
    if (cancelSignal?.aborted) throw new SyncCancelled();
    const sourceDir = path.dirname(trackPath);
    if (albums.has(sourceDir)) continue;

    const relPath = computeDeviceRelativePath(
      trackPath,
      trackInfo,
      contentType,
      options
    );
    const deviceRelAlbum = path.dirname(relPath).replace(/\\/g, "/");
    albums.set(sourceDir, { deviceRelAlbum, firstTrack: trackPath });
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;
  const failedAlbums: string[] = [];

  for (const [sourceDir, { deviceRelAlbum, firstTrack }] of albums) {
    if (cancelSignal?.aborted) throw new SyncCancelled();

    const source = await findAlbumArtSource(sourceDir, firstTrack);
    if (!source) continue;

    const destPath = path.join(deviceContentPath, deviceRelAlbum, "cover.jpg");
    const result = await generateRockboxCover(source, destPath, {
      maxDim,
      log: (message) => progressCallback?.({ event: "log", message }),
      signal: cancelSignal,
    });

    // Whether a cover needs writing is only known after the skip check, so the
    // total grows one item at a time alongside the processed count. The renderer
    // raises totalItems only on "total"/"total_add" but advances processedItems
    // on every "copy" event, so emitting one without the other pushes the bar
    // past 100% (e.g. "48/40 copied").
    if (result === "written") {
      copied++;
      progressCallback?.({ event: "total_add", path: "1" });
      progressCallback?.({
        event: "copy",
        path: destPath,
        destination: destPath,
        status: "copied",
        contentType: "artwork",
      });
    } else if (result === "skipped") {
      skipped++;
    } else {
      errors++;
      failedAlbums.push(sourceDir);
      progressCallback?.({ event: "total_add", path: "1" });
      progressCallback?.({
        event: "copy",
        path: sourceDir,
        destination: destPath,
        status: "error",
        contentType: "artwork",
      });
    }
  }

  return { copied, skipped, errors, totalCandidates: albums.size, failedAlbums };
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
 * Generate one Rockbox-compatible `cover.jpg` per album folder in a shadow
 * library root, mirroring the source folder structure. Used for all shadow
 * libraries regardless of codec. See sync/rockbox-cover.ts.
 */
export async function copyArtworkToShadowLibrary(
  allTracks: Track[],
  libraryFolderPaths: Map<number, string>,
  shadowRoot: string,
  progressCallback?: (msg: string) => void,
  signal?: AbortSignal,
  maxDim: number = DEFAULT_COVER_MAX_DIMENSION
): Promise<ArtworkSyncResult> {
  if (allTracks.length === 0) {
    return { copied: 0, skipped: 0, errors: 0, totalCandidates: 0, failedAlbums: [] };
  }

  const albums = new Map<string, { albumRel: string; firstTrack: string }>();

  for (const track of allTracks) {
    if (signal?.aborted) throw new SyncCancelled();
    const sourceDir = path.dirname(track.path);
    if (albums.has(sourceDir)) continue;

    const albumRel = computeShadowAlbumRelPath(
      sourceDir,
      libraryFolderPaths,
      track.libraryFolderId
    );
    albums.set(sourceDir, { albumRel, firstTrack: track.path });
  }

  let copied = 0;
  let skipped = 0;
  let errors = 0;
  const failedAlbums: string[] = [];

  for (const [sourceDir, { albumRel, firstTrack }] of albums) {
    if (signal?.aborted) throw new SyncCancelled();

    const source = await findAlbumArtSource(sourceDir, firstTrack);
    if (!source) continue;

    const destPath = path.join(shadowRoot, albumRel, "cover.jpg");
    const result = await generateRockboxCover(source, destPath, {
      maxDim,
      log: progressCallback,
      signal,
    });
    if (result === "written") {
      copied++;
      progressCallback?.(`Artwork generated: ${path.basename(destPath)}`);
    } else if (result === "skipped") {
      skipped++;
    } else {
      errors++;
      failedAlbums.push(sourceDir);
    }
  }

  return { copied, skipped, errors, totalCandidates: albums.size, failedAlbums };
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
  /** Album-artwork failures, counted apart from track/song-data failures. */
  artworkErrors: number;
}> {
  const { extraTrackPolicy, progressCallback, cancelSignal, skipAlbumArtwork, artworkMaxDimension, preloadedMtimes, profileCodecExtOverride, preserveFolderStructure, albumGrouping = "album-artist" } =
    options;
  let artworkErrors = 0;

  // Built once and handed to every pass below. The compare, the copy and the
  // artwork walk must agree on where a track lands, so they read the layout
  // from one object rather than each taking its own trailing arguments.
  const layout: LayoutOptions = {
    libraryFolderPaths,
    preserveFolderStructure,
    albumGrouping,
  };

  progressCallback?.({ event: "log", message: `Comparing library with device (${contentType})...` });

  const analysis = analyzeContentType(
    deviceFilesMap,
    deviceContentPath,
    libraryTracks,
    contentType,
    codecName,
    {
      ...layout,
      cancelSignal,
      progressCallback,
      preloadedMtimes,
      profileCodecExtOverride,
    }
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
  if ((extraTrackPolicy === "remove" || extraTrackPolicy === "remove-all") && analysis.extras.length > 0) {
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
    {
      ...layout,
      progressCallback,
      cancelSignal,
      deviceProfile: device.profile,
      codecMismatchMap: analysis.codecMismatchMap,
    }
  );

  if (skipAlbumArtwork !== true && Object.keys(libraryTracks).length > 0) {
    const artworkResult = await copyAlbumArtworkToDevice(
      deviceContentPath,
      contentType,
      libraryTracks,
      {
        ...layout,
        progressCallback,
        cancelSignal,
        maxDim: artworkMaxDimension ?? DEFAULT_COVER_MAX_DIMENSION,
      }
    );
    // Artwork failures are counted separately from track failures: they surface
    // as a sync failure of their own, but must never be mistaken for missing or
    // corrupt song data, and must not gate track-dependent steps (playlists).
    artworkErrors = artworkResult.errors;
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
        parts.push(`${artworkResult.errors} failed`);
      }
      progressCallback?.({
        event: "log",
        message: `Album artwork: ${parts.join(", ")}.`,
      });
    }
    if (artworkResult.errors > 0) {
      progressCallback?.({
        event: "log",
        message:
          `ALBUM ARTWORK FAILED for ${artworkResult.errors} album folder(s) — ` +
          `this is cover art only, not song data.` +
          (errors === 0
            ? " Every song file copied successfully."
            : ` Track problems are reported separately (${errors} song error(s)).`),
      });
      for (const album of artworkResult.failedAlbums) {
        progressCallback?.({
          event: "log",
          message: `  Album artwork failed: ${album}`,
        });
      }
    }
  }

  if (removedCount > 0) {
    cleanEmptyDirectories(deviceContentPath);
  }

  return {
    status: errors > 0 || artworkErrors > 0 ? "error" : "completed",
    synced,
    removed: removedCount,
    extras: extraTrackPolicy !== "remove" ? analysis.extras : [],
    missingFiles,
    errors,
    artworkErrors,
  };
}
