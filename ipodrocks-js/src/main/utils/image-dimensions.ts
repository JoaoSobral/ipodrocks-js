/**
 * Minimal JPEG/PNG dimension reader.
 *
 * The Rockbox cover generator needs to know how big an image is without pulling
 * in an image library: it re-encodes album art to a bounded baseline JPEG, and
 * must be able to tell whether an already-generated `cover.jpg` matches the
 * currently requested max dimension (see sync/rockbox-cover.ts). Only the two
 * formats we ever write or read as folder art are supported; anything else
 * returns null and callers fall back to their previous behaviour.
 */
import * as fs from "fs";

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Bytes read from the head of a file when probing dimensions. A JPEG's SOF
 * marker sits after any EXIF/ICC segments, which are comfortably under this in
 * practice; oversized headers simply yield null.
 */
const HEAD_BYTES = 128 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read dimensions from an in-memory image (e.g. an embedded cover picture). */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  return readPngDimensions(buf) ?? readJpegDimensions(buf);
}

/** Read dimensions from a file on disk, probing only its head. */
export function readImageDimensionsFromFile(
  filePath: string
): ImageDimensions | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return readImageDimensions(buf.subarray(0, read));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** PNG stores width/height in the IHDR chunk at a fixed offset. */
function readPngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Walk JPEG segments to the first SOFn frame header, which carries the real
 * dimensions. Handles both baseline (SOF0) and progressive (SOF2) sources.
 */
function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // 0xFF is a legal fill byte before the real marker.
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // Start of scan / end of image — frame header would have appeared already.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;

    // SOFn is 0xC0-0xCF excluding DHT (0xC4), JPG (0xC8) and DAC (0xCC).
    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrameHeader) {
      if (i + 9 >= buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    i += 2 + length;
  }
  return null;
}

/** Longest edge of an image, or null when dimensions can't be determined. */
export function longestEdge(dims: ImageDimensions | null): number | null {
  return dims ? Math.max(dims.width, dims.height) : null;
}
