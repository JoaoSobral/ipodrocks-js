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
import {
  makeSafeConversionTempPath,
  moveConvertedFile,
  runLoggedSubprocess,
} from "./sync-conversion";
import { SyncCancelled } from "./sync-core";

/** Default max cover dimension in px. Conservative to keep iPods responsive. */
export const DEFAULT_COVER_MAX_DIMENSION = 300;

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
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(albumDir, { withFileTypes: true });
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
      const full = path.join(albumDir, match);
      return { kind: "file", path: full, mtimeMs: safeMtime(full) };
    }
  }

  // Otherwise the largest remaining image (most likely the real cover).
  if (images.length > 0) {
    let best: { name: string; size: number } | null = null;
    for (const name of images) {
      const full = path.join(albumDir, name);
      const size = safeSize(full);
      if (!best || size > best.size) best = { name, size };
    }
    if (best) {
      const full = path.join(albumDir, best.name);
      return { kind: "file", path: full, mtimeMs: safeMtime(full) };
    }
  }

  // Fall back to embedded art from the first track (also covers opus/ogg
  // targets, whose transcode drops embedded pictures).
  const picture = await extractEmbeddedPicture(firstTrackPath);
  if (picture) {
    return { kind: "embedded", data: picture.data, mtimeMs: safeMtime(firstTrackPath) };
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

  // Skip if the destination cover is at least as new as the source.
  try {
    const destStat = fs.statSync(destCoverPath);
    if (destStat.mtimeMs >= source.mtimeMs) return "skipped";
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
      opts.signal
    );
    if (code !== 0 || !fs.existsSync(tmpDest)) {
      throw new Error(`ffmpeg exited ${code}`);
    }
    moveConvertedFile(tmpDest, destCoverPath);
    return "written";
  } catch (err) {
    if (err instanceof SyncCancelled) throw err;
    safeUnlink(tmpDest);
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
