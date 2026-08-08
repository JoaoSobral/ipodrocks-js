/**
 * Read the first embedded picture from an audio file.
 *
 * Shared by the podcast cover-art sidecar step and the Rockbox artwork
 * generator. MPC (Musepack) is read with our own APEv2 reader because
 * music-metadata's parseFile throws on tagged SV8 MPC.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { parseFile } from "music-metadata";
import { isMpcFile } from "./audio-extensions";
import { getEncoderEnv } from "./encoder-env";
import { getFfmpegPath } from "./ffmpeg-path";
import { readApeTags } from "../tagging/reader";

const execFileAsync = promisify(execFile);

/** Cover art is a few hundred KB in practice; cap well above that, not at Node's 1 MB default. */
const MAX_ART_BYTES = 64 * 1024 * 1024;
const ART_TIMEOUT_MS = 15_000;

export interface EmbeddedPicture {
  data: Uint8Array;
  /** MIME type as reported by the tag reader, e.g. "image/jpeg". */
  format: string;
}

/** Identify an image by magic bytes — ffmpeg gives us the pixels, not the MIME type. */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/**
 * Pull the attached picture out with ffmpeg, for files music-metadata cannot
 * parse.
 *
 * music-metadata (11.x) fails on Ogg/Opus whose cover art is large enough to
 * span multiple Ogg pages — it cannot reassemble the split comment and throws
 * "Offset is outside the bounds of the DataView" or "The string to be decoded
 * is not correctly encoded". Such files are perfectly valid; ffmpeg exposes the
 * art as an attached video stream and copies it out untouched.
 */
async function extractPictureViaFfmpeg(
  audioPath: string
): Promise<EmbeddedPicture | null> {
  try {
    const { stdout } = await execFileAsync(
      getFfmpegPath(),
      [
        "-v", "error",
        "-i", audioPath,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-c:v", "copy",
        "-f", "image2pipe",
        "-",
      ],
      {
        encoding: "buffer",
        maxBuffer: MAX_ART_BYTES,
        timeout: ART_TIMEOUT_MS,
        env: getEncoderEnv(),
      }
    );
    const buf = stdout as unknown as Buffer;
    if (!buf?.length) return null;

    // Only hand back something we can name; an unrecognised blob would be
    // written out as a cover with a bogus MIME type.
    const format = sniffImageMime(buf);
    if (!format) return null;

    return { data: new Uint8Array(buf), format };
  } catch {
    // No video stream, no ffmpeg, or a genuinely broken file — all non-fatal.
    return null;
  }
}

/**
 * Returns the embedded cover art, or null when there is none or the file
 * cannot be read. Never throws — callers treat missing art as non-fatal.
 */
export async function extractEmbeddedPicture(
  audioPath: string
): Promise<EmbeddedPicture | null> {
  if (isMpcFile(audioPath)) {
    try {
      const cover = readApeTags(audioPath).coverArt;
      return cover ? { data: cover.data, format: cover.mimeType } : null;
    } catch (err) {
      console.warn(
        `[embedded-art] read failed for ${audioPath}:`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  try {
    const metadata = await parseFile(audioPath, { duration: false });
    const picture = metadata.common.picture?.[0];
    return picture ? { data: picture.data, format: picture.format } : null;
  } catch (err) {
    // Only a *parse failure* falls back. A successful parse reporting no
    // picture is trusted: spawning ffmpeg for every art-less track would cost
    // a subprocess per album on a full sync.
    const picture = await extractPictureViaFfmpeg(audioPath);
    if (picture) return picture;
    console.warn(
      `[embedded-art] read failed for ${audioPath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
