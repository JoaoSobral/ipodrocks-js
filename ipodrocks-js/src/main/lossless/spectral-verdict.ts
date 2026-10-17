/**
 * Lossy-sourced ("fake lossless") detection — the pure half.
 *
 * A lossy encoder throws away the top of the spectrum: MP3 and AAC both put a
 * brick-wall low-pass somewhere between ~11 kHz (low bitrates) and ~20.5 kHz
 * (320 kbps), and above it there is nothing but the decoder's noise floor.
 * Decode that back to FLAC/ALAC and the wall survives, which is what this
 * module looks for. A genuine CD rip has content up to ~22 kHz or rolls off
 * gradually; a hi-res file upsampled from 44.1/48 kHz is empty above ~22/24 kHz.
 *
 * Input is a banded magnitude spectrum per frame (computed by Essentia in
 * `harmonic/essentia-worker.ts`); everything here is arithmetic on that, so it
 * can be tested against synthetic spectra with no WASM and no ffmpeg.
 *
 * Known blind spots, by construction: an MP3 encoded with no low-pass (some
 * high-VBR settings keep the full band) passes as genuine, and a genuine
 * recording mastered with a steep low-pass reads as a transcode. The report
 * always carries the cutoff so a person can judge the borderline ones.
 */

import type { LosslessVerdict } from "../../shared/types";

export type { LosslessVerdict };

/** Width of one analysis band. 200 Hz resolves every encoder's cutoff. */
export const BAND_HZ = 200;

/** A frame is "loud" (analysable) above this RMS. */
export const LOUD_FRAME_RMS_DB = -50;
/** Fewer analysable frames than this, or than this share, is inconclusive. */
export const MIN_LOUD_FRAMES = 10;
export const MIN_LOUD_SHARE = 0.1;
/** The cutoff is the highest band still within this many dB of the 2–8 kHz reference. */
export const CUTOFF_BELOW_REF_DB = 30;
/** A low-pass needs at least this drop across ~1 kHz around the cutoff… */
export const MIN_CLIFF_DB = 18;
/** …and the region above it this far below the reference. */
export const MIN_DEPTH_DB = 35;
/** Cutoffs at or above this share of Nyquist are the format's own anti-alias filter. */
export const NATURAL_CUTOFF_SHARE = 0.93;
/** Deep pass: share of loud frames empty above the cutoff for a "lossy" verdict at all. */
export const FAKE_EMPTY_SHARE = 0.85;
/**
 * "Strong" evidence: the wall is in practically every frame, the band above it
 * is dead, and the cutoff is either a sheer cliff or far below the format's
 * bandwidth — an MP3 128 → FLAC, not an edge case. All three must hold.
 */
export const STRONG_EMPTY_SHARE = 0.98;
export const STRONG_DEPTH_DB = 50;
export const STRONG_CLIFF_DB = 40;
export const STRONG_LOW_CUTOFF_HZ = 16500;
/** A frame's region above the cutoff counts as empty within this of the median frame's. */
const FRAME_FLOOR_MARGIN_DB = 10;
/** …or this far below the frame's own reference band. */
const FRAME_EMPTY_DEPTH_DB = 45;

export type LosslessStage = "light" | "deep";

/** Per-frame banded spectrum, as produced by the Essentia worker. */
export interface FrameBands {
  sampleRate: number;
  bandHz: number;
  nBands: number;
  /** nFrames × nBands, band power in dB, row-major. */
  bandsDb: Float32Array;
  /** One RMS (dBFS) per frame. */
  frameRmsDb: Float32Array;
}

export interface SpectralMetrics {
  sampleRate: number;
  frames: number;
  loudFrames: number;
  /** Highest frequency carrying real content; Nyquist when nothing cuts it. */
  cutoffHz: number;
  /** Drop across the cutoff (dB). */
  cliffDb: number;
  /** Reference band level minus the level above the cutoff (dB). */
  depthDb: number;
  /** Share of loud frames empty above the cutoff (deep metric, 0..1). */
  emptyShare: number;
  /** A brick-wall low-pass below the format's natural bandwidth. */
  lowpass: boolean;
}

export interface LosslessResult {
  verdict: LosslessVerdict;
  /** 0..1 — how sure the verdict is. */
  confidence: number;
  cutoffHz: number | null;
  /** Likely origin, e.g. "MP3 ~128 kbps", or null when genuine/inconclusive. */
  source: string | null;
  stage: LosslessStage;
  metrics: SpectralMetrics | null;
}

/** Merge several decoded windows of one file into one frame set. */
export function concatFrameBands(parts: FrameBands[]): FrameBands | null {
  const usable = parts.filter((p) => p.frameRmsDb.length > 0);
  if (usable.length === 0) return null;
  const first = usable[0];
  const same = usable.filter(
    (p) => p.sampleRate === first.sampleRate && p.nBands === first.nBands && p.bandHz === first.bandHz
  );
  const frames = same.reduce((n, p) => n + p.frameRmsDb.length, 0);
  const bandsDb = new Float32Array(frames * first.nBands);
  const frameRmsDb = new Float32Array(frames);
  let f = 0;
  for (const p of same) {
    bandsDb.set(p.bandsDb, f * first.nBands);
    frameRmsDb.set(p.frameRmsDb, f);
    f += p.frameRmsDb.length;
  }
  return { sampleRate: first.sampleRate, bandHz: first.bandHz, nBands: first.nBands, bandsDb, frameRmsDb };
}

function meanRange(a: ArrayLike<number>, lo: number, hi: number, offset = 0): number {
  const from = Math.max(0, lo);
  if (hi < from) return Number.NaN;
  let s = 0;
  for (let k = from; k <= hi; k++) s += a[offset + k];
  return s / (hi - from + 1);
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Measure the spectrum. Returns null when there is too little loud audio to judge. */
export function measureSpectrum(fb: FrameBands): SpectralMetrics | null {
  const { nBands, bandHz, sampleRate } = fb;
  const frames = fb.frameRmsDb.length;
  const nyquist = sampleRate / 2;
  const loud: number[] = [];
  for (let i = 0; i < frames; i++) if (fb.frameRmsDb[i] > LOUD_FRAME_RMS_DB) loud.push(i);
  if (loud.length < MIN_LOUD_FRAMES || loud.length < frames * MIN_LOUD_SHARE || nBands < 8) return null;

  const band = (hz: number): number => Math.max(0, Math.min(nBands - 1, Math.floor(hz / bandHz)));

  // Average spectrum over the loud frames, in power, back to dB.
  const avgPow = new Float64Array(nBands);
  for (const i of loud) {
    const row = i * nBands;
    for (let k = 0; k < nBands; k++) avgPow[k] += Math.pow(10, fb.bandsDb[row + k] / 10);
  }
  const avg = Array.from(avgPow, (p) => 10 * Math.log10(p / loud.length + 1e-30));

  const refLo = band(2000);
  const refHi = band(Math.min(8000, nyquist * 0.5));
  const ref = meanRange(avg, refLo, refHi);

  // Highest band (two in a row, so one tonal spike cannot fake it) still
  // within CUTOFF_BELOW_REF_DB of the reference.
  const threshold = ref - CUTOFF_BELOW_REF_DB;
  let cutBand = nBands - 1;
  for (let k = nBands - 2; k >= refHi; k--) {
    if (avg[k] >= threshold && avg[k - 1] >= threshold) {
      cutBand = k;
      break;
    }
    cutBand = k;
  }
  const cutoffHz = Math.min(nyquist, (cutBand + 1) * bandHz);

  const aboveLo = cutBand + Math.ceil(1000 / bandHz);
  const aboveHi = nBands - 1 - Math.ceil(400 / bandHz);
  const hasAbove = aboveLo <= aboveHi;
  const floorAbove = hasAbove ? meanRange(avg, aboveLo, aboveHi) : ref;
  const depthDb = ref - floorAbove;
  const before = meanRange(avg, cutBand - Math.ceil(800 / bandHz), cutBand - 1);
  const after = meanRange(
    avg,
    cutBand + Math.ceil(600 / bandHz),
    Math.min(nBands - 1, cutBand + Math.ceil(1200 / bandHz))
  );
  const cliffDb = Number.isFinite(before) && Number.isFinite(after) ? before - after : 0;

  const lowpass =
    hasAbove &&
    cutoffHz < nyquist * NATURAL_CUTOFF_SHARE &&
    cliffDb >= MIN_CLIFF_DB &&
    depthDb >= MIN_DEPTH_DB;

  // Per frame: is the region above the cutoff empty in this frame too? A
  // lossy file's is empty in essentially every frame; a natural roll-off
  // lets cymbals and transients through now and then. "Empty" is judged
  // against the *median* frame — the averaged spectrum is no good here, since
  // when a few frames carry content above the cutoff they are the only energy
  // there and would set the very floor they are measured against.
  let empty = 0;
  if (hasAbove) {
    const frameAbove = new Float64Array(loud.length);
    const frameRef = new Float64Array(loud.length);
    loud.forEach((i, j) => {
      const row = i * nBands;
      frameRef[j] = meanRange(fb.bandsDb, refLo, refHi, row);
      frameAbove[j] = meanRange(fb.bandsDb, aboveLo, aboveHi, row);
    });
    const sorted = Float64Array.from(frameAbove).sort();
    const medianFloor = sorted[Math.floor(sorted.length / 2)];
    for (let j = 0; j < loud.length; j++) {
      if (frameAbove[j] <= medianFloor + FRAME_FLOOR_MARGIN_DB || frameRef[j] - frameAbove[j] >= FRAME_EMPTY_DEPTH_DB) {
        empty++;
      }
    }
  }

  return {
    sampleRate,
    frames,
    loudFrames: loud.length,
    cutoffHz: Math.round(cutoffHz),
    cliffDb: Math.round(cliffDb * 10) / 10,
    depthDb: Math.round(depthDb * 10) / 10,
    emptyShare: hasAbove ? Math.round((empty / loud.length) * 1000) / 1000 : 0,
    lowpass,
  };
}

/**
 * A resampler's anti-alias filter is gentle: upsampling 44.1 or 48 kHz audio
 * leaves its content fading out anywhere from ~20.6 to ~26.5 kHz, so the two
 * sources cannot be told apart reliably and are not.
 */
export const UPSAMPLED_CUTOFF_MIN_HZ = 20600;
export const UPSAMPLED_CUTOFF_MAX_HZ = 26500;

function isUpsampledCutoff(cutoffHz: number, sampleRate: number): boolean {
  return sampleRate > 48000 && cutoffHz >= UPSAMPLED_CUTOFF_MIN_HZ && cutoffHz <= UPSAMPLED_CUTOFF_MAX_HZ;
}

/** Best guess at what the file was before it became lossless. */
export function estimateSource(cutoffHz: number, sampleRate: number): string {
  if (isUpsampledCutoff(cutoffHz, sampleRate)) return "Upsampled from 44.1/48 kHz";
  if (cutoffHz < 11500) return "MP3 ≤64 kbps";
  if (cutoffHz < 14500) return "MP3 ~96 kbps";
  if (cutoffHz < 16500) return "MP3 ~128 kbps";
  if (cutoffHz < 17800) return "MP3 ~160–192 kbps / AAC 128";
  if (cutoffHz < 19200) return "MP3 ~224–256 kbps / AAC";
  if (cutoffHz < 20600) return "MP3 320 kbps / AAC 256+";
  return "Lossy (unknown)";
}

function strength(m: SpectralMetrics): number {
  return 0.5 * clamp01((m.cliffDb - MIN_CLIFF_DB) / 40) + 0.5 * clamp01((m.depthDb - MIN_DEPTH_DB) / 40);
}

function isStrong(m: SpectralMetrics): boolean {
  return (
    m.emptyShare >= STRONG_EMPTY_SHARE &&
    m.depthDb >= STRONG_DEPTH_DB &&
    (m.cliffDb >= STRONG_CLIFF_DB || m.cutoffHz <= STRONG_LOW_CUTOFF_HZ)
  );
}

/** Light pass: genuine, possibly_lossy, or inconclusive. Never "lossy" on its own. */
export function classifyLight(fb: FrameBands | null): LosslessResult {
  const m = fb ? measureSpectrum(fb) : null;
  if (!m) return { verdict: "inconclusive", confidence: 0, cutoffHz: null, source: null, stage: "light", metrics: m };
  if (!m.lowpass) {
    return { verdict: "genuine", confidence: 0.7, cutoffHz: m.cutoffHz, source: null, stage: "light", metrics: m };
  }
  return {
    verdict: "possibly_lossy",
    confidence: Math.round((0.5 + 0.3 * strength(m)) * 100) / 100,
    cutoffHz: m.cutoffHz,
    source: estimateSource(m.cutoffHz, m.sampleRate),
    stage: "light",
    metrics: m,
  };
}

/** Deep pass over the whole file: the final word. */
export function classifyDeep(fb: FrameBands | null): LosslessResult {
  const m = fb ? measureSpectrum(fb) : null;
  if (!m) return { verdict: "inconclusive", confidence: 0, cutoffHz: null, source: null, stage: "deep", metrics: m };
  if (!m.lowpass) {
    return { verdict: "genuine", confidence: 0.85, cutoffHz: m.cutoffHz, source: null, stage: "deep", metrics: m };
  }
  const source = estimateSource(m.cutoffHz, m.sampleRate);
  if (isUpsampledCutoff(m.cutoffHz, m.sampleRate) && m.emptyShare >= FAKE_EMPTY_SHARE) {
    const confidence = 0.7 + 0.29 * clamp01((m.emptyShare - FAKE_EMPTY_SHARE) / (1 - FAKE_EMPTY_SHARE));
    return { verdict: "upsampled", confidence: Math.round(confidence * 100) / 100, cutoffHz: m.cutoffHz, source, stage: "deep", metrics: m };
  }
  if (isStrong(m)) {
    const confidence = 0.9 + 0.09 * strength(m);
    return { verdict: "lossy_strong", confidence: Math.round(Math.min(0.99, confidence) * 100) / 100, cutoffHz: m.cutoffHz, source, stage: "deep", metrics: m };
  }
  if (m.emptyShare >= FAKE_EMPTY_SHARE) {
    const confidence = 0.6 + 0.2 * strength(m) + 0.09 * clamp01((m.emptyShare - FAKE_EMPTY_SHARE) / (1 - FAKE_EMPTY_SHARE));
    return { verdict: "lossy", confidence: Math.round(Math.min(0.89, confidence) * 100) / 100, cutoffHz: m.cutoffHz, source, stage: "deep", metrics: m };
  }
  return {
    verdict: "possibly_lossy",
    confidence: Math.round((0.4 + 0.3 * strength(m)) * 100) / 100,
    cutoffHz: m.cutoffHz,
    source,
    stage: "deep",
    metrics: m,
  };
}
