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
  id: number;
  wavPath: string;
}

export interface EssentiaWorkerResponse {
  id: number;
  result: { key: string | null; bpm: number | null; camelot: string | null } | null;
  /** Set when Essentia itself could not be loaded — not a fact about the track. */
  unavailable?: boolean;
}

/** VectorFloat returned by arrayToVector; must be freed with .delete() to avoid WASM heap leak. */
type EssentiaVector = unknown & { delete?: () => void };

type EssentiaEngine = {
  arrayToVector: (a: Float32Array) => EssentiaVector;
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

parentPort?.on("message", (req: EssentiaWorkerRequest) => {
  parentPort?.postMessage(handle(req));
});
