/**
 * Audio analysis using Essentia.js for key and BPM detection.
 * Decodes audio via ffmpeg, runs KeyExtractor and RhythmExtractor2013.
 *
 * The VectorFloat from arrayToVector is explicitly deleted after each track
 * (Embind does not auto-free); otherwise the WASM heap grows until analysis
 * fails after ~97 tracks. Module.print/printErr are set to suppress "undefined" spam.
 */

import * as fs from "fs";

// Set Emscripten Module.print/printErr before Essentia WASM loads. The WASM uses
// these for stdout/stderr; if unset it falls back to console.log/console.warn.
// Must run before require("essentia.js") to suppress "undefined" spam.
const g = globalThis as typeof globalThis & { Module?: Record<string, unknown> };
g.Module = { ...g.Module, print: () => {}, printErr: () => {} };
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { app } from "electron";
import { toCamelot } from "./camelotWheel";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wav = require("node-wav");

let cachedFfmpegPath: string | null = null;

function getFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  if (app.isPackaged && process.resourcesPath) {
    const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const candidate = path.join(process.resourcesPath, "ffmpeg", name);
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }
  const ffmpeg = require("@ffmpeg-installer/ffmpeg");
  cachedFfmpegPath = ffmpeg.path;
  return cachedFfmpegPath as string;
}

export interface EssentiaFeatures {
  key: string | null;
  bpm: number | null;
  camelot: string | null;
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

let essentiaInstance: EssentiaPkg | null = null;
let cachedEngine: EssentiaEngine | null = null;

/** Number of tracks analyzed since last engine reset. Used to periodically recreate the engine to avoid WASM memory buildup. */
let tracksSinceReset = 0;

/** Reset the cached engine so the next analysis creates a fresh instance. Call periodically to avoid memory leaks. */
export function resetEssentiaEngine(): void {
  cachedEngine = null;
  tracksSinceReset = 0;
}

function getEssentia(): EssentiaPkg | null {
  if (essentiaInstance) return essentiaInstance;
  try {
    essentiaInstance = require("essentia.js") as EssentiaPkg;
    return essentiaInstance;
  } catch {
    return null;
  }
}

/**
 * Suppress all console and process output during Essentia calls.
 * Emscripten may use console.warn for stderr; belt-and-suspenders.
 */
function suppressOutput<T>(fn: () => T): T {
  const origLog = console.log;
  const origWarn = console.warn;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const noopWrite = (
    _chunk: unknown,
    enc?: unknown,
    cb?: unknown
  ): boolean => {
    if (typeof enc === "function") (enc as () => void)();
    else if (typeof cb === "function") (cb as () => void)();
    return true;
  };
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  process.stdout.write = noopWrite as typeof process.stdout.write;
  process.stderr.write = noopWrite as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
}

/**
 * Return a reusable Essentia WASM engine, creating it once.
 * Suppresses the WASM module's stdout to avoid "undefined" spam.
 */
function getOrCreateEngine(): EssentiaEngine | null {
  if (cachedEngine) return cachedEngine;
  const pkg = getEssentia();
  if (!pkg) return null;

  cachedEngine = suppressOutput(() => new pkg.Essentia(pkg.EssentiaWASM));
  return cachedEngine;
}

/**
 * Decode audio file to mono Float32Array at 44100Hz using ffmpeg (async).
 */
function decodeAudioToFloat32(filePath: string): Promise<Float32Array | null> {
  const tmpDir = os.tmpdir();
  const tmpWav = path.join(
    tmpDir,
    `ipodrocks-essentia-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );
  const ffmpegPath = getFfmpegPath();
  return new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        filePath,
        "-f",
        "wav",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-t",
        "120",
        tmpWav,
      ],
      { stdio: "pipe" }
    );
    proc.on("close", (code) => {
      try {
        if (code !== 0 || !fs.existsSync(tmpWav)) {
          resolve(null);
          return;
        }
        const buf = fs.readFileSync(tmpWav);
        const decoded = wav.decode(buf);
        if (!decoded?.channelData?.length) {
          resolve(null);
          return;
        }
        const mono = decoded.channelData[0] as Float32Array;
        resolve(mono);
      } catch {
        resolve(null);
      } finally {
        try {
          if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
        } catch {
          // ignore
        }
      }
    });
    proc.on("error", () => resolve(null));
  });
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

/** Recreate the Essentia engine every N tracks as a safety net (vector is now freed per track). */
const ESSENTIA_RESET_INTERVAL = 500;

/**
 * Analyze audio file for key and BPM using Essentia.js.
 * Reuses a single WASM instance and periodically resets it to avoid
 * memory buildup that causes the process to die after many tracks.
 * Console and stdout output are suppressed during analysis to avoid
 * "undefined" spam from the WASM module.
 *
 * @returns Features or null if analysis fails / Essentia unavailable.
 */
export async function analyzeAudioWithEssentia(
  filePath: string
): Promise<EssentiaFeatures | null> {
  if (tracksSinceReset >= ESSENTIA_RESET_INTERVAL) {
    resetEssentiaEngine();
  }
  const essentia = getOrCreateEngine();
  if (!essentia) return null;

  const audio = await decodeAudioToFloat32(filePath);
  if (!audio || audio.length < 1000) return null;

  try {
    const result = suppressOutput(() => {
      const vector = essentia.arrayToVector(audio);
      try {
        let key: string | null = null;
        let camelot: string | null = null;
        let bpm: number | null = null;

        try {
          const keyResult = essentia.KeyExtractor(vector);
          if (keyResult?.key) {
            const normalized = essentiaKeyToNormalized(
              keyResult.key,
              keyResult.scale ?? ""
            );
            if (normalized) {
              key = normalized;
              camelot = toCamelot(normalized);
            }
          }
        } catch {
          // Key extraction failed
        }

        try {
          const rhythmResult = essentia.RhythmExtractor2013(vector);
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
    tracksSinceReset++;
    return result;
  } catch {
    return null;
  }
}
