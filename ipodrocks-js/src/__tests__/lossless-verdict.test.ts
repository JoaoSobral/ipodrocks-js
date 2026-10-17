/**
 * @vitest-environment node
 *
 * The lossless check's verdict logic, on synthetic banded spectra — no WASM,
 * no ffmpeg. Each shape is the one the real fixtures produce (see
 * `regressions/lossless-check-pipeline.test.ts` for those, end to end):
 * a flat full-band spectrum (genuine), a brick wall at ~15.4 kHz with nothing
 * above (an MP3 128 → FLAC), a wall at ~17 kHz that is only modestly deep (an
 * edit made from a compressed bounce), a gradual natural roll-off, a 96 kHz
 * file empty above CD bandwidth, and near-silence.
 */
import { describe, expect, it } from "vitest";
import {
  BAND_HZ,
  classifyDeep,
  classifyLight,
  concatFrameBands,
  estimateSource,
  measureSpectrum,
  type FrameBands,
} from "../main/lossless/spectral-verdict";

interface Shape {
  sampleRate?: number;
  frames?: number;
  rmsDb?: number;
  /** dB level for a band centred at `hz` in frame `f`. */
  level: (hz: number, f: number) => number;
}

function synth({ sampleRate = 44100, frames = 400, rmsDb = -20, level }: Shape): FrameBands {
  const nBands = Math.floor(sampleRate / 2 / BAND_HZ);
  const bandsDb = new Float32Array(frames * nBands);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < nBands; k++) bandsDb[f * nBands + k] = level((k + 0.5) * BAND_HZ, f);
  }
  return { sampleRate, bandHz: BAND_HZ, nBands, bandsDb, frameRmsDb: new Float32Array(frames).fill(rmsDb) };
}

/** Music-ish slope: -3 dB per octave above 1 kHz, a little per-frame wobble. */
const music = (hz: number, f: number): number => -50 - 3 * Math.log2(Math.max(hz, 1000) / 1000) + Math.sin(f + hz / 997);
const FLOOR = -120;

describe("measureSpectrum / classify — the shapes the check must tell apart", () => {
  it("full-band audio is genuine, with the cutoff at Nyquist", () => {
    const fb = synth({ level: music });
    const m = measureSpectrum(fb)!;
    expect(m.lowpass).toBe(false);
    expect(m.cutoffHz).toBeGreaterThan(21000);
    expect(classifyLight(fb).verdict).toBe("genuine");
    expect(classifyDeep(fb).verdict).toBe("genuine");
  });

  it("an MP3-128-style wall at 15.4 kHz is lossy-sourced (strong), never more than a suspicion from the light pass", () => {
    const fb = synth({ level: (hz, f) => (hz < 15400 ? music(hz, f) : FLOOR) });
    const deep = classifyDeep(fb);
    expect(deep.verdict).toBe("lossy_strong");
    expect(deep.confidence).toBeGreaterThanOrEqual(0.9);
    expect(deep.cutoffHz).toBeGreaterThanOrEqual(15200);
    expect(deep.cutoffHz).toBeLessThanOrEqual(15600);
    expect(deep.source).toBe("MP3 ~128 kbps");
    // The light pass sees one window; it only ever raises a suspicion.
    expect(classifyLight(fb).verdict).toBe("possibly_lossy");
  });

  it("a shallower wall near 17 kHz is lossy-sourced but not strong — the edge case gets the weaker word", () => {
    // The "sped up" edit's shape: the music thins out over the last
    // kilohertz before the wall, so the cliff is ~20-30 dB rather than the
    // 60+ of a straight MP3 transcode, though the band above is just as dead.
    const fb = synth({
      level: (hz, f) => (hz < 16000 ? music(hz, f) : hz < 17200 ? -78 : -112),
    });
    const m = measureSpectrum(fb)!;
    expect(m.cliffDb).toBeLessThan(40);
    const r = classifyDeep(fb);
    expect(r.verdict).toBe("lossy");
    expect(r.confidence).toBeLessThan(0.9);
  });

  it("a wall that faint content crosses in a fifth of the frames is only possibly lossy-sourced", () => {
    const fb = synth({
      // Above the wall: nothing in most frames, but every fifth frame carries
      // something ~30 dB down — too faint to fill the average, too frequent
      // for an encoder that discarded the band.
      level: (hz, f) => (hz < 15400 ? music(hz, f) : f % 5 === 0 ? music(hz, f) - 30 : FLOOR),
    });
    expect(classifyDeep(fb).verdict).toBe("possibly_lossy");
  });

  it("a gradual natural roll-off is genuine however far down it ends", () => {
    // -6 dB per kHz above 12 kHz: down 60 dB by 22 kHz, but no cliff anywhere.
    const fb = synth({ level: (hz, f) => music(hz, f) - Math.max(0, (hz - 12000) / 1000) * 6 });
    const m = measureSpectrum(fb)!;
    expect(m.cliffDb).toBeLessThan(18);
    expect(classifyDeep(fb).verdict).toBe("genuine");
  });

  it("a 96 kHz file with nothing above CD bandwidth is upsampled, not lossy", () => {
    const fb = synth({ sampleRate: 96000, level: (hz, f) => (hz < 21800 ? music(hz, f) : FLOOR) });
    const r = classifyDeep(fb);
    expect(r.verdict).toBe("upsampled");
    expect(r.source).toBe("Upsampled from 44.1/48 kHz");
  });

  it("a genuine 96 kHz file is genuine", () => {
    expect(classifyDeep(synth({ sampleRate: 96000, level: music })).verdict).toBe("genuine");
  });

  it("near-silence is inconclusive, not genuine and not lossy", () => {
    const fb = synth({ rmsDb: -80, level: (hz, f) => (hz < 15400 ? music(hz, f) : FLOOR) });
    expect(measureSpectrum(fb)).toBeNull();
    expect(classifyLight(fb).verdict).toBe("inconclusive");
    expect(classifyDeep(fb).verdict).toBe("inconclusive");
    expect(classifyDeep(null).verdict).toBe("inconclusive");
  });
});

describe("concatFrameBands", () => {
  it("joins windows of one file and drops a window with a different shape", () => {
    const a = synth({ frames: 10, level: music });
    const b = synth({ frames: 5, level: music });
    const other = synth({ sampleRate: 48000, frames: 7, level: music });
    const joined = concatFrameBands([a, other, b])!;
    expect(joined.frameRmsDb.length).toBe(15);
    expect(joined.bandsDb.length).toBe(15 * a.nBands);
    expect(concatFrameBands([])).toBeNull();
  });
});

describe("estimateSource", () => {
  it("maps an encoder's cutoff to its likely bitrate", () => {
    expect(estimateSource(11000, 44100)).toBe("MP3 ≤64 kbps");
    expect(estimateSource(16000, 44100)).toBe("MP3 ~128 kbps");
    expect(estimateSource(17400, 44100)).toBe("MP3 ~160–192 kbps / AAC 128");
    expect(estimateSource(19400, 44100)).toBe("MP3 320 kbps / AAC 256+");
    expect(estimateSource(22000, 96000)).toBe("Upsampled from 44.1/48 kHz");
  });
});
