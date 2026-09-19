/**
 * Fill the ReplayGain values in a Musepack SV8 stream header (issue #137).
 *
 * Musepack is the format that introduced native ReplayGain, and it keeps it in
 * the stream header rather than in the tag — the `RG` packet, which the spec
 * makes mandatory and which every compliant player reads. Rockbox reads only
 * that packet; the `REPLAYGAIN_*` items in the APEv2 tag are a fallback it
 * consults afterwards and never lets overwrite what the header said.
 *
 * `mpcenc` reserves the packet and leaves every field zero — it has no
 * ReplayGain option, and the encode is fed a tagless WAV anyway — so iPodRocks
 * writes all four values itself, from the tags read off the source track.
 *
 * Layout, big-endian throughout. A packet is two ASCII key bytes, a
 * variable-length size (7 bits per byte, high bit = "one more", **counting the
 * key and size bytes themselves**) and a payload:
 *
 * ```
 * MPCK | SH <size> <stream header> | RG <size> 01 <t.gain:s16> <t.peak:u16> <a.gain:s16> <a.peak:u16> | EI … | AP …
 *    0 | 4                         | 18 for mpcenc 1.30.1: fields at 22, 24, 26, 28
 * ```
 *
 * `gain = round((64.82 - dB) * 256)` and `peak = round(20*log10(linear*32768) *
 * 256)` — Rockbox's `SV8_TO_SV7_CONVERT_GAIN` (6482) and
 * `SV8_TO_SV7_CONVERT_PEAK` (23119) are the same two constants. **`0` means
 * "not computed"**, so a value we actually hold must never encode to it.
 *
 * Three rules, all of them enforced below, all of them from Rockbox's
 * `lib/rbcodec/metadata/mpc.c`:
 *
 * - **The `RG` packet must sit immediately after `SH`.**
 *   `get_musepack_metadata()` reads 32 bytes from offset 6 and jumps
 *   `SH_size - 2` to find it. A file whose packet is somewhere else is refused
 *   rather than rewritten: nothing here may insert or move a packet, both
 *   because the reader would not find it and because the `SO` packet holds an
 *   absolute seek-table offset that shifting bytes would invalidate.
 * - **A gain whose peak is 0 is ignored entirely** (`if (peak != 0)` in
 *   `set_replaygain_sv8()`), so gain and peak are written as a pair. A gain
 *   arriving without one gets a full-scale peak rather than being dropped.
 * - The header wins over the tag, which is why the caller may drop the
 *   `REPLAYGAIN_*` items once a write here succeeds.
 *
 * **Safety: this is a fixed-size patch.** Nine bytes inside an existing packet
 * are overwritten; the size field is never rewritten and no byte is inserted or
 * moved. The file's length and every absolute offset in it — the APEv2 block's
 * included — come out identical, so a caller may compute the tag block's
 * position before this runs and still write it afterwards.
 *
 * Timestamps are deliberately **not** restored here. This is a primitive; its
 * caller owns the mtime, so a repair that patches the header and rewrites the
 * tag can do both under a single stat/utimes pair.
 */

import * as fsp from "fs/promises";

import type { ReplayGainValues } from "../replaygain-keys";

/** Enough of the start of the file to hold `MPCK`, `SH` and `RG`. */
const MPC_HEAD_PROBE_SIZE = 64;

/** Rockbox `SV8_TO_SV7_CONVERT_GAIN = 6482`, i.e. 64.82 dB × 100. */
const GAIN_REFERENCE_DB = 64.82;
/** Rockbox `SV8_TO_SV7_CONVERT_PEAK = 23119 = 256 * 20 * log10(32768)`. */
export const PEAK_FULL_SCALE_RAW = 23119;

/** The last offset Rockbox's 32-byte read from offset 6 reaches. */
const ROCKBOX_HEAD_WINDOW_END = 6 + 32;

const MPCK_MAGIC = "MPCK";

/** The four fields as they are stored: 0 in any of them means "not computed". */
export interface Sv8ReplayGainRaw {
  trackGain: number;
  trackPeak: number;
  albumGain: number;
  albumPeak: number;
}

export interface RgPacketLocation {
  /** Absolute offset of the `R` of `RG`. */
  start: number;
  /** Whole packet: key + size bytes + payload. */
  size: number;
  /** Absolute offset of the payload's version byte. */
  payloadStart: number;
  payloadLength: number;
  version: number;
  /** Whether the packet ends inside the 32 bytes Rockbox reads from offset 6. */
  rockboxVisible: boolean;
}

export type HeaderWriteOutcome = "written" | "unchanged" | "unsupported" | "failed";

export const ZERO_RAWS: Sv8ReplayGainRaw = {
  trackGain: 0,
  trackPeak: 0,
  albumGain: 0,
  albumPeak: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * dB → the stored Q8.8 word. Never returns the 0 sentinel for a real value:
 * a gain of exactly 64.82 dB is not a number any scanner produces, but the
 * guard removes the case rather than reasoning about it.
 */
export function encodeGain(gainDb: number): number {
  if (!Number.isFinite(gainDb)) return 0;
  const raw = clamp(Math.round((GAIN_REFERENCE_DB - gainDb) * 256), -32768, 32767);
  return raw === 0 ? 1 : raw;
}

export function decodeGain(raw: number): number | null {
  if (raw === 0) return null;
  return GAIN_REFERENCE_DB - raw / 256;
}

/** Linear peak → the stored word: `20*log10(peak * 32768) * 256`. */
export function encodePeak(peakLinear: number): number {
  if (!Number.isFinite(peakLinear) || peakLinear <= 0) return 0;
  return clamp(Math.round(20 * Math.log10(peakLinear * 32768) * 256), 1, 65535);
}

export function decodePeak(raw: number): number | null {
  if (raw === 0) return null;
  return Math.pow(10, raw / (256 * 20)) / 32768;
}

/**
 * Read one SV8 size. Bounded at five bytes: a run of 0x80s in a corrupt file
 * must not spin, and no packet this module cares about is anywhere near that
 * large.
 */
function readVarint(buf: Buffer, pos: number): { value: number; len: number } | null {
  let value = 0;
  let len = 0;
  for (;;) {
    if (pos + len >= buf.length || len >= 5) return null;
    const byte = buf[pos + len];
    len++;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, len };
  }
}

/**
 * Find the `RG` packet, which must be the packet immediately after `SH`.
 * Returns null — meaning "leave this file alone" — for an SV7 (`MP+`) file, a
 * file with no `RG` packet, one whose `RG` sits behind another packet, and
 * anything malformed or truncated.
 */
export function locateSv8ReplayGainPacket(head: Buffer): RgPacketLocation | null {
  if (head.length < 8) return null;
  if (head.toString("ascii", 0, 4) !== MPCK_MAGIC) return null;
  if (head.toString("ascii", 4, 6) !== "SH") return null;

  const shSize = readVarint(head, 6);
  if (!shSize) return null;
  if (shSize.value < 2 + shSize.len) return null;

  const start = 4 + shSize.value;
  if (start + 2 > head.length) return null;
  if (head.toString("ascii", start, start + 2) !== "RG") return null;

  const rgSize = readVarint(head, start + 2);
  if (!rgSize) return null;

  const payloadStart = start + 2 + rgSize.len;
  const payloadLength = rgSize.value - 2 - rgSize.len;
  if (payloadLength < 9) return null;
  if (payloadStart + 9 > head.length) return null;
  if (start + rgSize.value > head.length) return null;

  return {
    start,
    size: rgSize.value,
    payloadStart,
    payloadLength,
    version: head[payloadStart],
    rockboxVisible: start + rgSize.value <= ROCKBOX_HEAD_WINDOW_END,
  };
}

export function readSv8ReplayGainRaw(head: Buffer, loc: RgPacketLocation): Sv8ReplayGainRaw {
  const p = loc.payloadStart;
  return {
    trackGain: head.readInt16BE(p + 1),
    trackPeak: head.readUInt16BE(p + 3),
    albumGain: head.readInt16BE(p + 5),
    albumPeak: head.readUInt16BE(p + 7),
  };
}

/**
 * What the four fields should read after the write: a value we hold wins, a
 * value we lack keeps whatever the file already had.
 *
 * Gain and peak are decided as a pair because Rockbox reads them as one — a
 * gain with a zero peak is skipped outright, so a lone gain would make the file
 * look tagged and do nothing. A gain that arrives without a peak therefore gets
 * a full-scale one (the honest "unknown, assume no headroom" reading; it only
 * makes a player's clipping prevention conservative, and clipping prevention is
 * off by default in Rockbox).
 *
 * {@link writeMpcReplayGainHeader} is the only caller, and compares the result
 * against what the file already holds to decide whether to write at all — so
 * this function alone defines both "what to write" and "is a write needed",
 * and the two can never disagree.
 */
export function computeTargetRaws(
  existing: Sv8ReplayGainRaw,
  values: ReplayGainValues,
  log?: (line: string) => void
): Sv8ReplayGainRaw {
  const pair = (
    gainDb: number | undefined,
    peak: number | undefined,
    existingGain: number,
    existingPeak: number,
    label: string
  ): [number, number] => {
    let gain = gainDb != null ? encodeGain(gainDb) : existingGain;
    let peakRaw = peak != null ? encodePeak(peak) : existingPeak;
    if (gain !== 0 && peakRaw === 0) {
      peakRaw = PEAK_FULL_SCALE_RAW;
      log?.(`ReplayGain ${label} peak missing; assuming full scale so the gain is applied`);
    }
    // A peak with no gain at all says nothing a player can use, but it is also
    // not ours to erase: leave whatever was there.
    if (gain === 0) peakRaw = existingPeak;
    return [gain, peakRaw];
  };

  const [trackGain, trackPeak] = pair(
    values.trackGainDb,
    values.trackPeak,
    existing.trackGain,
    existing.trackPeak,
    "track"
  );
  const [albumGain, albumPeak] = pair(
    values.albumGainDb,
    values.albumPeak,
    existing.albumGain,
    existing.albumPeak,
    "album"
  );
  return { trackGain, trackPeak, albumGain, albumPeak };
}

function rawsEqual(a: Sv8ReplayGainRaw, b: Sv8ReplayGainRaw): boolean {
  return (
    a.trackGain === b.trackGain &&
    a.trackPeak === b.trackPeak &&
    a.albumGain === b.albumGain &&
    a.albumPeak === b.albumPeak
  );
}

async function readHead(filePath: string): Promise<Buffer | null> {
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const wanted = Math.min(size, MPC_HEAD_PROBE_SIZE);
    if (wanted < 8) return null;
    const head = Buffer.alloc(wanted);
    await handle.read(head, 0, wanted, 0);
    return head;
  } finally {
    await handle.close();
  }
}

/** The four stored values, or null when the file has no readable `RG` packet. */
export async function readMpcReplayGainHeader(
  filePath: string
): Promise<Sv8ReplayGainRaw | null> {
  let head: Buffer | null;
  try {
    head = await readHead(filePath);
  } catch {
    return null;
  }
  if (!head) return null;
  const loc = locateSv8ReplayGainPacket(head);
  if (!loc || loc.version !== 1) return null;
  return readSv8ReplayGainRaw(head, loc);
}

/**
 * Patch the `RG` packet in place.
 *
 * - `"written"` — the nine payload bytes were rewritten; the file's size is
 *   unchanged and nothing outside the packet was touched.
 * - `"unchanged"` — the packet already says this; nothing was written at all,
 *   which is what makes a repeated repair pass report nothing to do.
 * - `"unsupported"` — no packet this module may write (SV7, no `RG`, an `RG`
 *   that is not adjacent to `SH`, an unknown payload version, a truncated
 *   file). The file is untouched.
 * - `"failed"` — the read or write threw.
 */
export async function writeMpcReplayGainHeader(
  filePath: string,
  values: ReplayGainValues,
  log?: (line: string) => void
): Promise<HeaderWriteOutcome> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r+");
  } catch {
    return "failed";
  }

  try {
    const { size } = await handle.stat();
    const wanted = Math.min(size, MPC_HEAD_PROBE_SIZE);
    if (wanted < 8) return "unsupported";
    const head = Buffer.alloc(wanted);
    await handle.read(head, 0, wanted, 0);

    const loc = locateSv8ReplayGainPacket(head);
    if (!loc) return "unsupported";
    if (loc.version !== 1) return "unsupported";

    const existing = readSv8ReplayGainRaw(head, loc);
    const target = computeTargetRaws(existing, values, log);
    if (rawsEqual(existing, target)) return "unchanged";

    const payload = Buffer.alloc(9);
    payload[0] = 1; // RG payload version
    payload.writeInt16BE(target.trackGain, 1);
    payload.writeUInt16BE(target.trackPeak, 3);
    payload.writeInt16BE(target.albumGain, 5);
    payload.writeUInt16BE(target.albumPeak, 7);

    await handle.write(payload, 0, payload.byteLength, loc.payloadStart);
    await handle.sync();

    if (!loc.rockboxVisible) {
      // Spec-correct either way, but Rockbox only reads 32 bytes from offset 6
      // and will not see this one. Worth a line in the log rather than a silent
      // write that appears to fix nothing on the player.
      log?.(`ReplayGain header written past Rockbox's 32-byte window: ${filePath}`);
    }
    return "written";
  } catch {
    return "failed";
  } finally {
    await handle.close();
  }
}
