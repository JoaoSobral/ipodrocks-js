/**
 * Essentia key/BPM analysis, run inside a `worker_threads` Worker.
 *
 * `KeyExtractor` and `RhythmExtractor2013` are synchronous Embind calls into
 * WASM, seconds long for two minutes of audio. On the main thread that is
 * seconds of a frozen event loop per track — every HTTP request, WebSocket
 * frame and device RPC of every user of the daemon waiting on one backfill.
 * Here it blocks nothing but this worker, and the main thread can end a track
 * that runs too long with `worker.terminate()`, which interrupts WASM
 * mid-loop; nothing inside a synchronous call on the main thread could.
 *
 * The protocol is one request at a time: `{ id, wavPath }` in, `{ id, result }`
 * out, where `result` is `null` when the file could not be analysed. The WAV
 * is written by the main thread's ffmpeg decode and belongs to it — this side
 * only reads it.
 *
 * A second request kind, `{ kind: "bands" }`, serves the lossless check
 * (`lossless/`): it takes PCM samples directly and returns a banded magnitude
 * spectrum per frame, computed with Essentia's `Windowing` + `Spectrum`. The
 * verdict is decided on the main thread by pure code
 * (`lossless/spectral-verdict.ts`); this side only measures.
 *
 * The VectorFloat from arrayToVector is explicitly deleted after each track
 * (Embind does not auto-free); otherwise the WASM heap grows until analysis
 * fails after ~97 tracks. Module.print/printErr are set to suppress
 * "undefined" spam.
 */
import * as fs from "fs";
import { parentPort } from "worker_threads";

// Set Emscripten Module.print/printErr before Essentia WASM loads. The WASM uses
// these for stdout/stderr; if unset it falls back to console.log/console.warn.
// Must run before require("essentia.js") to suppress "undefined" spam.
const g = globalThis as typeof globalThis & { Module?: Record<string, unknown> };
g.Module = { ...g.Module, print: () => {}, printErr: () => {} };

import { toCamelot } from "./camelotWheel";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wav = require("node-wav");

export interface EssentiaWorkerRequest {
  kind?: "features";
  id: number;
  wavPath: string;
}

export interface EssentiaWorkerResponse {
  id: number;
  result: { key: string | null; bpm: number | null; camelot: string | null } | null;
  /** Set when Essentia itself could not be loaded — not a fact about the track. */
  unavailable?: boolean;
}

/** Banded spectrum per frame, for the lossless check. */
export interface EssentiaBandsRequest {
  kind: "bands";
  id: number;
  samples: Float32Array;
  sampleRate: number;
  bandHz: number;
  /** Half-overlapping frames (deep pass) instead of back-to-back (light pass). */
  overlap: boolean;
}

export interface EssentiaBandsResponse {
  id: number;
  result: {
    sampleRate: number;
    bandHz: number;
    nBands: number;
    bandsDb: Float32Array;
    frameRmsDb: Float32Array;
  } | null;
  unavailable?: boolean;
}

/** VectorFloat returned by arrayToVector; must be freed with .delete() to avoid WASM heap leak. */
type EssentiaVector = unknown & { delete?: () => void };

type EssentiaEngine = {
  arrayToVector: (a: Float32Array) => EssentiaVector;
  vectorToArray: (v: EssentiaVector) => Float32Array;
  Windowing: (
    frame: EssentiaVector,
    normalized?: boolean,
    size?: number,
    type?: string
  ) => { frame: EssentiaVector };
  Spectrum: (frame: EssentiaVector, size?: number) => { spectrum: EssentiaVector };
  KeyExtractor: (v: EssentiaVector) => { key: string; scale: string };
  RhythmExtractor2013: (v: EssentiaVector) => { bpm: number };
  shutdown: () => void;
};

type EssentiaPkg = {
  Essentia: new (w: unknown) => EssentiaEngine;
  EssentiaWASM: unknown;
};

/** Recreate the Essentia engine every N tracks as a safety net (vector is now freed per track). */
const ESSENTIA_RESET_INTERVAL = 500;

let essentiaPkg: EssentiaPkg | null = null;
let cachedEngine: EssentiaEngine | null = null;
let tracksSinceReset = 0;

/**
 * Silence console output during Essentia calls. Emscripten may use
 * console.warn for stderr; a worker's console is forwarded to the main
 * thread's, so it would otherwise still reach the log.
 */
function suppressOutput<T>(fn: () => T): T {
  const origLog = console.log;
  const origWarn = console.warn;
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

function getOrCreateEngine(): EssentiaEngine | null {
  if (tracksSinceReset >= ESSENTIA_RESET_INTERVAL) {
    cachedEngine = null;
    tracksSinceReset = 0;
  }
  if (cachedEngine) return cachedEngine;
  if (!essentiaPkg) {
    try {
      essentiaPkg = require("essentia.js") as EssentiaPkg;
    } catch {
      return null;
    }
  }
  const pkg = essentiaPkg;
  cachedEngine = suppressOutput(() => new pkg.Essentia(pkg.EssentiaWASM));
  return cachedEngine;
}

/**
 * Map Essentia key (e.g. "C", "A") + scale ("major", "minor") to our format.
 */
function essentiaKeyToNormalized(key: string, scale: string): string | null {
  if (!key) return null;
  const k = key.trim();
  if (scale?.toLowerCase() === "minor") return k + "m";
  return k;
}

function readMonoSamples(wavPath: string): Float32Array | null {
  try {
    const decoded = wav.decode(fs.readFileSync(wavPath));
    if (!decoded?.channelData?.length) return null;
    return decoded.channelData[0] as Float32Array;
  } catch {
    return null;
  }
}

function analyze(engine: EssentiaEngine, audio: Float32Array): EssentiaWorkerResponse["result"] {
  return suppressOutput(() => {
    const vector = engine.arrayToVector(audio);
    try {
      let key: string | null = null;
      let camelot: string | null = null;
      let bpm: number | null = null;

      try {
        const keyResult = engine.KeyExtractor(vector);
        if (keyResult?.key) {
          const normalized = essentiaKeyToNormalized(keyResult.key, keyResult.scale ?? "");
          if (normalized) {
            key = normalized;
            camelot = toCamelot(normalized);
          }
        }
      } catch {
        // Key extraction failed
      }

      try {
        const rhythmResult = engine.RhythmExtractor2013(vector);
        if (rhythmResult?.bpm != null && rhythmResult.bpm > 0) {
          bpm = Math.round(rhythmResult.bpm * 10) / 10;
        }
      } catch {
        // BPM extraction failed
      }

      return { key, bpm, camelot };
    } finally {
      // Free WASM heap: Embind vectors must be deleted or the heap grows until analysis fails (~97 tracks).
      vector.delete?.();
    }
  });
}

function handle(req: EssentiaWorkerRequest): EssentiaWorkerResponse {
  const engine = getOrCreateEngine();
  if (!engine) return { id: req.id, result: null, unavailable: true };
  const audio = readMonoSamples(req.wavPath);
  if (!audio || audio.length < 1000) return { id: req.id, result: null };
  try {
    const result = analyze(engine, audio);
    tracksSinceReset++;
    return { id: req.id, result };
  } catch {
    return { id: req.id, result: null };
  }
}

/**
 * Per frame: Hann window, magnitude spectrum, then mean power per `bandHz`
 * band in dB. Every Embind vector is deleted as soon as it is read — the same
 * heap rule as `analyze()`, multiplied by the thousands of frames in a track.
 */
function computeBands(engine: EssentiaEngine, req: EssentiaBandsRequest): EssentiaBandsResponse["result"] {
  const { samples, sampleRate, bandHz } = req;
  const frameSize = sampleRate > 48000 ? 4096 : 2048;
  const hop = req.overlap ? frameSize / 2 : frameSize;
  const nBands = Math.floor(sampleRate / 2 / bandHz);
  const binHz = sampleRate / frameSize;
  const nFrames = samples.length >= frameSize ? Math.floor((samples.length - frameSize) / hop) + 1 : 0;
  if (nFrames === 0 || nBands < 1) return null;
  const bandsDb = new Float32Array(nFrames * nBands);
  const frameRmsDb = new Float32Array(nFrames);
  const lo = new Int32Array(nBands);
  const hi = new Int32Array(nBands);
  for (let k = 0; k < nBands; k++) {
    lo[k] = Math.round((k * bandHz) / binHz);
    hi[k] = Math.max(lo[k] + 1, Math.round(((k + 1) * bandHz) / binHz));
  }
  return suppressOutput(() => {
    for (let f = 0; f < nFrames; f++) {
      const frame = samples.subarray(f * hop, f * hop + frameSize);
      let energy = 0;
      for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
      frameRmsDb[f] = 10 * Math.log10(energy / frameSize + 1e-20);

      const vector = engine.arrayToVector(frame);
      let windowed: EssentiaVector | undefined;
      let spectrum: EssentiaVector | undefined;
      try {
        windowed = engine.Windowing(vector, true, frameSize, "hann").frame;
        spectrum = engine.Spectrum(windowed, frameSize).spectrum;
        const mag = engine.vectorToArray(spectrum);
        const row = f * nBands;
        for (let k = 0; k < nBands; k++) {
          let p = 0;
          const end = Math.min(hi[k], mag.length);
          for (let i = lo[k]; i < end; i++) p += mag[i] * mag[i];
          bandsDb[row + k] = 10 * Math.log10(p / (hi[k] - lo[k]) + 1e-30);
        }
      } finally {
        vector.delete?.();
        windowed?.delete?.();
        spectrum?.delete?.();
      }
    }
    return { sampleRate, bandHz, nBands, bandsDb, frameRmsDb };
  });
}

function handleBands(req: EssentiaBandsRequest): EssentiaBandsResponse {
  const engine = getOrCreateEngine();
  if (!engine) return { id: req.id, result: null, unavailable: true };
  try {
    const result = computeBands(engine, req);
    tracksSinceReset++;
    return { id: req.id, result };
  } catch {
    return { id: req.id, result: null };
  }
}

parentPort?.on("message", (req: EssentiaWorkerRequest | EssentiaBandsRequest) => {
  if (req.kind === "bands") {
    const res = handleBands(req);
    const transfer = res.result ? [res.result.bandsDb.buffer as ArrayBuffer, res.result.frameRmsDb.buffer as ArrayBuffer] : [];
    parentPort?.postMessage(res, transfer);
    return;
  }
  parentPort?.postMessage(handle(req));
});
