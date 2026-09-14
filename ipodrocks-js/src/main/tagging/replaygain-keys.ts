/**
 * The four ReplayGain tag names, and the parsing that turns their string forms
 * into numbers.
 *
 * This module imports nothing on purpose. `sync/` already imports `tagging/`
 * and nothing in `tagging/` imports `sync/`, so the shared names have to live
 * on this side of that line: `sync/sync-conversion.ts` produces the values,
 * `tagging/mpc/replaygain-header.ts` and `tagging/mpc/repair.ts` consume them,
 * and none of it forms a cycle.
 */

export const REPLAYGAIN_TRACK_GAIN = "REPLAYGAIN_TRACK_GAIN";
export const REPLAYGAIN_TRACK_PEAK = "REPLAYGAIN_TRACK_PEAK";
export const REPLAYGAIN_ALBUM_GAIN = "REPLAYGAIN_ALBUM_GAIN";
export const REPLAYGAIN_ALBUM_PEAK = "REPLAYGAIN_ALBUM_PEAK";

/** The four names as they are written into a file (APEv2/Vorbis spelling). */
export const REPLAYGAIN_TAG_NAMES = [
  REPLAYGAIN_TRACK_GAIN,
  REPLAYGAIN_TRACK_PEAK,
  REPLAYGAIN_ALBUM_GAIN,
  REPLAYGAIN_ALBUM_PEAK,
] as const;

/** Upper-cased, for matching a key of unknown spelling. */
export const REPLAYGAIN_TAG_NAME_SET: ReadonlySet<string> = new Set(REPLAYGAIN_TAG_NAMES);

/** The lowercase spelling MP4 freeform-atom taggers conventionally use. */
export const REPLAYGAIN_KEYS_LOWER = REPLAYGAIN_TAG_NAMES.map((k) =>
  k.toLowerCase()
) as readonly string[];

/** ReplayGain as numbers: gains in dB, peaks as a linear ratio. */
export interface ReplayGainValues {
  trackGainDb?: number;
  trackPeak?: number;
  albumGainDb?: number;
  albumPeak?: number;
}

/**
 * `"-3.38 dB"` → `-3.38`. The unit is optional and so is the space before it:
 * music-metadata's own `toRatio()` splits on a space and hands back
 * `{ dB: null }` for the unspaced spelling (see the `readSourceApeTags()`
 * hazard in CLAUDE.md), and writing a second parser with the same blind spot
 * is the obvious mistake to make here.
 */
export function parseGainDb(value: string | undefined): number | null {
  if (value == null) return null;
  const m = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:dB)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * `"0.998054"` → `0.998054`. A peak above 1.0 is legal — it is exactly what a
 * clipping track reports — so only zero, negative and non-finite are refused.
 */
export function parsePeakRatio(value: string | undefined): number | null {
  if (value == null) return null;
  const m = /^([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The ReplayGain entries out of a tag bucket, keyed case-insensitively and
 * returned upper-cased. Everything else is dropped.
 */
export function pickReplayGainStrings(
  extra: Record<string, string> | undefined
): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!extra) return picked;
  for (const [key, value] of Object.entries(extra)) {
    const upper = key.toUpperCase();
    if (REPLAYGAIN_TAG_NAME_SET.has(upper)) picked[upper] = value;
  }
  return picked;
}

/** Parse a tag bucket into numbers, dropping anything that doesn't parse. */
export function replayGainValuesFromStrings(
  extra: Record<string, string> | undefined
): ReplayGainValues {
  const picked = pickReplayGainStrings(extra);
  const values: ReplayGainValues = {};
  const trackGain = parseGainDb(picked[REPLAYGAIN_TRACK_GAIN]);
  const trackPeak = parsePeakRatio(picked[REPLAYGAIN_TRACK_PEAK]);
  const albumGain = parseGainDb(picked[REPLAYGAIN_ALBUM_GAIN]);
  const albumPeak = parsePeakRatio(picked[REPLAYGAIN_ALBUM_PEAK]);
  if (trackGain != null) values.trackGainDb = trackGain;
  if (trackPeak != null) values.trackPeak = trackPeak;
  if (albumGain != null) values.albumGainDb = albumGain;
  if (albumPeak != null) values.albumPeak = albumPeak;
  return values;
}

export function hasAnyReplayGain(values: ReplayGainValues): boolean {
  return (
    values.trackGainDb != null ||
    values.trackPeak != null ||
    values.albumGainDb != null ||
    values.albumPeak != null
  );
}

/**
 * A copy of `extra` with the four ReplayGain entries removed — used once the
 * values are in the stream header, which is the only place Rockbox reads them
 * for Musepack (issue #137).
 */
export function dropReplayGainStrings(
  extra: Record<string, string> | undefined
): Record<string, string> {
  const kept: Record<string, string> = {};
  if (!extra) return kept;
  for (const [key, value] of Object.entries(extra)) {
    if (!REPLAYGAIN_TAG_NAME_SET.has(key.toUpperCase())) kept[key] = value;
  }
  return kept;
}
