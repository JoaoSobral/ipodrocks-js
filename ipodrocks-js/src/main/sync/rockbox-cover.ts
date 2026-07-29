/**
 * Generate Rockbox-compatible album artwork.
 *
 * Rockbox reliably displays a `cover.jpg` in the track's folder, but only
 * BASELINE (non-progressive) JPEG within tight memory limits — progressive or
 * oversized images (common in tagged libraries and folder scans) fail to load
 * or slow the device down. We therefore always re-encode the best available
 * source art into a single small baseline JPEG per album folder, using the
 * bundled ffmpeg (its `mjpeg` encoder can only emit baseline JPEG). No image
 * library dependency is required.
 *
 * A per-device max dimension keeps files small; iPods in particular get slow
 * with large cover art, so the default is deliberately conservative.
 */
import * as fs from "fs";
import * as path from "path";

import { getFfmpegPath } from "../utils/ffmpeg-path";
import { extractEmbeddedPicture } from "../utils/embedded-art";
import { findOnDisk } from "../utils/normalize-path";
import {
  longestEdge,
  readImageDimensions,
  readImageDimensionsFromFile,
} from "../utils/image-dimensions";
import {
  isCancellationError,
  makeSafeConversionTempPath,
  moveConvertedFile,
  runLoggedSubprocess,
} from "./sync-conversion";
import { SyncCancelled } from "./sync-core";

/** Default max cover dimension in px. Conservative to keep iPods responsive. */
export const DEFAULT_COVER_MAX_DIMENSION = 300;

/**
 * Wall-clock cap for a single cover conversion. Generous for real album art;
 * bounds the damage from a decompression-bomb image, which ffmpeg must fully
 * decode before the `scale` filter can shrink it.
 */
const COVER_FFMPEG_TIMEOUT_MS = 20_000;

/**
 * ffmpeg rounds the scaled output to even dimensions, so a regenerated cover
 * can land a pixel or two off the requested bound. Treat anything within this
 * tolerance as matching.
 */
const DIMENSION_TOLERANCE = 2;

/** Folder-art basenames, in preference order (any casing on disk). */
const FOLDER_ART_BASENAMES = ["cover", "folder", "front", "album"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];

export type CoverSource =
  | { kind: "file"; path: string; mtimeMs: number }
  | { kind: "embedded"; data: Uint8Array; mtimeMs: number };

export type CoverResult = "written" | "skipped" | "failed";

/**
 * Pick the best source art for an album directory: a preferred folder-art file
 * (cover/folder/front/album), else the largest other image in the dir, else
 * the embedded picture of the first track. Returns null when there is none.
 */
export async function findAlbumArtSource(
  albumDir: string,
  firstTrackPath: string
): Promise<CoverSource | null> {
  // Both arguments are derived from DB-stored (NFC) track paths, but on
  // normalization-sensitive filesystems (SMB/SAMBA, ext4) only the on-disk
  // form resolves — see utils/normalize-path.ts. Resolve before any I/O, or
  // cover generation silently finds nothing on exactly the mounts that
  // motivated the NFC scheme in the first place.
  const diskAlbumDir = findOnDisk(albumDir);
  const diskTrackPath = findOnDisk(firstTrackPath);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(diskAlbumDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  const images = entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);

  // Preferred basenames first.
  for (const base of FOLDER_ART_BASENAMES) {
    const match = images.find((name) => path.parse(name).name.toLowerCase() === base);
    if (match) {
      const full = path.join(diskAlbumDir, match);
      return { kind: "file", path: full, mtimeMs: safeMtime(full) };
    }
  }

  // Otherwise the largest remaining image (most likely the real cover).
  if (images.length > 0) {
    let best: { name: string; size: number } | null = null;
    for (const name of images) {
      const full = path.join(diskAlbumDir, name);
      const size = safeSize(full);
      if (!best || size > best.size) best = { name, size };
    }
    if (best) {
      const full = path.join(diskAlbumDir, best.name);
      return { kind: "file", path: full, mtimeMs: safeMtime(full) };
    }
  }

  // Fall back to embedded art from the first track (also covers opus/ogg
  // targets, whose transcode drops embedded pictures).
  const picture = await extractEmbeddedPicture(diskTrackPath);
  if (picture) {
    return { kind: "embedded", data: picture.data, mtimeMs: safeMtime(diskTrackPath) };
  }
  return null;
}

/**
 * Build the ffmpeg argv that downscales `src` (fit within `maxDim`, never
 * upscale) and re-encodes it as a baseline JPEG at `dest`. Pure — unit-tested
 * directly.
 */
export function buildCoverFfmpegArgs(
  src: string,
  dest: string,
  maxDim: number
): string[] {
  const scale =
    `scale='min(iw,${maxDim})':'min(ih,${maxDim})':force_original_aspect_ratio=decrease,` +
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  return [
    getFfmpegPath(),
    "-y",
    "-i", src,
    "-frames:v", "1",
    "-vf", scale,
    "-c:v", "mjpeg",
    "-q:v", "2",
    "-pix_fmt", "yuvj420p",
    "-an",
    "-map_metadata", "-1",
    dest,
  ];
}

/**
 * Generate `destCoverPath` (a `cover.jpg`) from `source`. Skips when an
 * up-to-date cover already exists. On ffmpeg failure falls back to a verbatim
 * copy of a source file (better than nothing). Never throws except on cancel.
 */
export async function generateRockboxCover(
  source: CoverSource,
  destCoverPath: string,
  opts: {
    maxDim?: number;
    log?: (line: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<CoverResult> {
  if (opts.signal?.aborted) throw new SyncCancelled();
  const maxDim = opts.maxDim ?? DEFAULT_COVER_MAX_DIMENSION;

  // Skip only when the destination cover is at least as new as the source AND
  // was generated at the size currently requested. Mtime alone is not enough:
  // changing a device's artwork_max_dimension does not touch the source art, so
  // every already-synced cover would silently keep its old size.
  try {
    const destStat = fs.statSync(destCoverPath);
    if (destStat.mtimeMs >= source.mtimeMs && coverMatchesMaxDim(destCoverPath, source, maxDim)) {
      return "skipped";
    }
  } catch {
    /* no existing cover — generate */
  }

  try {
    fs.mkdirSync(path.dirname(destCoverPath), { recursive: true });
  } catch (err) {
    opts.log?.(`Artwork: mkdir failed for ${destCoverPath}: ${errMsg(err)}`);
    return "failed";
  }

  // ffmpeg needs a file input; write embedded bytes to a scratch file first.
  let srcFile: string;
  let scratch: string | null = null;
  if (source.kind === "file") {
    srcFile = source.path;
  } else {
    scratch = makeSafeConversionTempPath(destCoverPath + ".src");
    try {
      fs.writeFileSync(scratch, source.data);
    } catch (err) {
      opts.log?.(`Artwork: temp write failed: ${errMsg(err)}`);
      return "failed";
    }
    srcFile = scratch;
  }

  const tmpDest = makeSafeConversionTempPath(destCoverPath);
  try {
    const code = await runLoggedSubprocess(
      buildCoverFfmpegArgs(srcFile, tmpDest, maxDim),
      opts.log,
      opts.signal,
      undefined,
      COVER_FFMPEG_TIMEOUT_MS
    );
    if (code !== 0 || !fs.existsSync(tmpDest)) {
      throw new Error(`ffmpeg exited ${code}`);
    }
    moveConvertedFile(tmpDest, destCoverPath);
    return "written";
  } catch (err) {
    safeUnlink(tmpDest);
    if (err instanceof SyncCancelled) throw err;
    // runLoggedSubprocess signals abort with a plain Error("Cancelled") rather
    // than SyncCancelled (it can't import it without a cycle). Without this,
    // cancelling mid-ffmpeg fell through to the fallback below and kept writing
    // covers after the user asked to stop.
    if (isCancellationError(err)) throw new SyncCancelled();
    // Fallback: copy a source file verbatim (embedded-only sources can't).
    if (source.kind === "file") {
      try {
        fs.copyFileSync(source.path, destCoverPath);
        opts.log?.(`Artwork: ffmpeg failed, copied original (${errMsg(err)})`);
        return "written";
      } catch (copyErr) {
        opts.log?.(`Artwork: generate + copy both failed: ${errMsg(copyErr)}`);
      }
    } else {
      opts.log?.(`Artwork: embedded art conversion failed: ${errMsg(err)}`);
    }
    return "failed";
  } finally {
    if (scratch) safeUnlink(scratch);
  }
}

/**
 * Does an existing cover already reflect `maxDim`?
 *
 * A cover larger than the bound means the setting was lowered. A cover smaller
 * than the bound is only stale if the source actually has pixels to spare —
 * small source art is never upscaled, so it legitimately stays under the bound
 * forever. When dimensions can't be read (unknown format), report a match so
 * behaviour falls back to the plain mtime check rather than regenerating on
 * every single sync.
 */
function coverMatchesMaxDim(
  destCoverPath: string,
  source: CoverSource,
  maxDim: number
): boolean {
  const destLongest = longestEdge(readImageDimensionsFromFile(destCoverPath));
  if (destLongest == null) return true;

  if (destLongest > maxDim + DIMENSION_TOLERANCE) return false;

  if (destLongest < maxDim - DIMENSION_TOLERANCE) {
    const srcLongest = sourceLongestEdge(source);
    if (srcLongest != null && srcLongest > destLongest + DIMENSION_TOLERANCE) {
      return false;
    }
  }
  return true;
}

/** Longest edge of the source art, or null when it can't be determined. */
function sourceLongestEdge(source: CoverSource): number | null {
  if (source.kind === "file") {
    return longestEdge(readImageDimensionsFromFile(source.path));
  }
  const buf = Buffer.from(
    source.data.buffer,
    source.data.byteOffset,
    source.data.byteLength
  );
  return longestEdge(readImageDimensions(buf));
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
