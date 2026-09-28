import * as fs from "fs";
import * as path from "path";

/**
 * What a downloaded enclosure is allowed to be, decided by its bytes.
 *
 * Podcast episodes and audiobook chapters are fetched from URLs inside a feed
 * somebody else wrote, and the file then goes to music-metadata, to ffmpeg (as
 * `-i <path>`, for cover art and transcodes) and out to a device. ffmpeg picks
 * its demuxer by *probing content*, and some demuxers open further files: an
 * HLS playlist (`#EXTM3U` + an absolute path per segment) makes ffmpeg read
 * whatever server media file it names. Storing the enclosure under the
 * extension the URL carried, with no look at the bytes, let a feed author pick
 * that demuxer at will.
 *
 * So two rules, applied to every enclosure download:
 *
 * 1. **The content must start with a known audio container's magic**, at
 *    offset 0 or immediately after ID3v2 tags. ffmpeg's probe skips a
 *    well-formed ID3v2 header before looking, so we must judge what follows it
 *    the same way — `ID3` + `#EXTM3U` is a playlist to ffmpeg. The list is
 *    positive: nothing else gets written.
 * 2. **The extension on disk comes from this module's table**, never from the
 *    URL. The URL's extension is kept only when it is one this container is
 *    legitimately spelled with (`.m4b` for an `ftyp` file); otherwise the
 *    container's canonical extension is used.
 */

export type AudioContainer =
  | "mpeg"
  | "adts"
  | "adif"
  | "mp4"
  | "ogg"
  | "flac"
  | "wav"
  | "aiff"
  | "asf"
  | "mpc"
  | "ape"
  | "wavpack";

/** Allowed extensions per container; the first is the canonical one. */
const EXTENSIONS: Record<AudioContainer, readonly string[]> = {
  mpeg: [".mp3", ".mp2", ".mpga"],
  adts: [".aac"],
  adif: [".aac"],
  mp4: [".m4a", ".m4b", ".mp4", ".m4v", ".mov", ".3gp"],
  ogg: [".ogg", ".oga", ".opus"],
  flac: [".flac"],
  wav: [".wav"],
  aiff: [".aiff", ".aif", ".aifc"],
  asf: [".wma"],
  mpc: [".mpc", ".mpp"],
  ape: [".ape"],
  wavpack: [".wv"],
};

const ALL_EXTENSIONS = new Set(Object.values(EXTENSIONS).flat());

export function isAllowedEnclosureExtension(ext: string): boolean {
  return ALL_EXTENSIONS.has(ext.toLowerCase());
}

function urlExtension(url: string): string {
  try {
    return path.extname(new URL(url).pathname).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The extension to use before the bytes are in: the URL's if it is on the
 * allowlist, `.mp3` otherwise. Only ever a placeholder for the row while the
 * download runs — {@link enclosureExtension} decides the real one.
 */
export function provisionalEnclosureExtension(url: string): string {
  const ext = urlExtension(url);
  return isAllowedEnclosureExtension(ext) ? ext : ".mp3";
}

/** The on-disk extension for a sniffed container, from the fixed table. */
export function enclosureExtension(url: string, container: AudioContainer): string {
  const allowed = EXTENSIONS[container];
  const ext = urlExtension(url);
  return allowed.includes(ext) ? ext : allowed[0];
}

const ASF_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);
const MP4_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

function ascii(buf: Buffer, start: number, len: number): string {
  return buf.subarray(start, start + len).toString("latin1");
}

/**
 * Judges the bytes at the very start of `buf` (no ID3 handling — see
 * {@link sniffAudioFile}). Returns `null` for anything not on the list.
 */
export function sniffAudioContainer(buf: Buffer): AudioContainer | null {
  if (buf.length < 4) return null;
  const four = ascii(buf, 0, 4);
  if (four === "fLaC") return "flac";
  if (four === "OggS") return "ogg";
  if (four === "MPCK" || ascii(buf, 0, 3) === "MP+") return "mpc";
  if (four === "MAC ") return "ape";
  if (four === "wvpk") return "wavpack";
  if (four === "ADIF") return "adif";
  if ((four === "RIFF" || four === "RF64") && buf.length >= 12 && ascii(buf, 8, 4) === "WAVE") {
    return "wav";
  }
  if (four === "FORM" && buf.length >= 12 && /^AIF[FC]$/.test(ascii(buf, 8, 4))) return "aiff";
  if (buf.length >= 8 && MP4_FIRST_BOXES.has(ascii(buf, 4, 4))) return "mp4";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(ASF_GUID)) return "asf";

  // Frame sync: eleven set bits. Layer 00 is ADTS (AAC); anything else is an
  // MPEG audio frame, checked for the reserved values a random 0xFFEx pair
  // would usually hit.
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const layer = (buf[1] >> 1) & 0x03;
    if (layer === 0) return (buf[1] & 0xf6) === 0xf0 ? "adts" : null;
    const version = (buf[1] >> 3) & 0x03;
    const bitrate = (buf[2] >> 4) & 0x0f;
    const sampleRate = (buf[2] >> 2) & 0x03;
    if (version !== 1 && bitrate !== 0x0f && sampleRate !== 0x03) return "mpeg";
  }
  return null;
}

/**
 * Length of the ID3v2 tag at `buf[0]`, or 0 if there is not a well-formed one.
 * Well-formed is exactly ffmpeg's `ff_id3v2_match()`: `ID3`, version bytes
 * other than 0xFF, four syncsafe size bytes — so we skip precisely when ffmpeg
 * would.
 */
function id3v2Length(buf: Buffer): number {
  if (buf.length < 10 || ascii(buf, 0, 3) !== "ID3") return 0;
  if (buf[3] === 0xff || buf[4] === 0xff) return 0;
  if ((buf[6] | buf[7] | buf[8] | buf[9]) & 0x80) return 0;
  const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const PROBE_BYTES = 64 * 1024;
const MAX_STACKED_ID3 = 4;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

/**
 * Sniffs a file on disk. Skips (possibly stacked) ID3v2 tags and any NUL
 * padding after them — both routine in real MP3s — then judges what is there.
 *
 * A file that starts `ID3` but whose header is not well-formed is accepted as
 * MPEG: ffmpeg will not skip it, so to every demuxer it begins with `ID3`,
 * which no playlist format does, and music-metadata reads it as an MP3.
 */
export function sniffAudioFile(filePath: string): AudioContainer | null {
  const fd = fs.openSync(filePath, "r");
  try {
    let offset = 0;
    for (let i = 0; i < MAX_STACKED_ID3; i++) {
      const head = readAt(fd, offset, 10);
      if (ascii(head, 0, 3) !== "ID3") break;
      const len = id3v2Length(head);
      if (len === 0) return offset === 0 ? "mpeg" : null;
      offset += len;
    }
    const probe = readAt(fd, offset, PROBE_BYTES);
    // Only NUL padding may sit in front of the first frame. Scanning past
    // anything else would let `#EXTM3U…` hide in front of a sync word; a NUL
    // is safe to skip because every reference-following format (HLS, concat,
    // DASH) must *begin* with its own text signature.
    // (Judge the unskipped bytes first: an MP4 box header *starts* with NULs.)
    const direct = sniffAudioContainer(probe);
    if (direct) return direct;
    let start = 0;
    while (start < probe.length && probe[start] === 0) start++;
    return start > 0 ? sniffAudioContainer(probe.subarray(start)) : null;
  } finally {
    fs.closeSync(fd);
  }
}

export class NotAudioError extends Error {
  constructor() {
    super("Downloaded file is not a recognised audio format");
    this.name = "NotAudioError";
  }
}
