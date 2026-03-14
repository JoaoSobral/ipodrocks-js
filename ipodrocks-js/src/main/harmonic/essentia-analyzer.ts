/**
 * Audio analysis using Essentia.js for key and BPM detection.
 * Decodes audio via ffmpeg, runs KeyExtractor and RhythmExtractor2013.
 *
 * A single WASM Essentia instance is reused across all tracks to
 * avoid the memory leak caused by repeatedly instantiating and
 * shutting down the WASM module. Console output from the WASM
 * module is suppressed to prevent "undefined" spam on stdout.
 */

import * as fs from "fs";
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

type EssentiaEngine = {
  arrayToVector: (a: Float32Array) => unknown;
  KeyExtractor: (v: unknown) => { key: string; scale: string };
  RhythmExtractor2013: (v: unknown) => { bpm: number };
  shutdown: () => void;
};

type EssentiaPkg = {
  Essentia: new (w: unknown) => EssentiaEngine;
  EssentiaWASM: unknown;
};

let essentiaInstance: EssentiaPkg | null = null;
let cachedEngine: EssentiaEngine | null = null;

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
 * Return a reusable Essentia WASM engine, creating it once.
 * Suppresses the WASM module's stdout to avoid "undefined" spam.
 */
function getOrCreateEngine(): EssentiaEngine | null {
  if (cachedEngine) return cachedEngine;
  const pkg = getEssentia();
  if (!pkg) return null;

  const origLog = console.log;
  console.log = () => {};
  try {
    cachedEngine = new pkg.Essentia(pkg.EssentiaWASM);
  } finally {
    console.log = origLog;
  }
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

/**
 * Analyze audio file for key and BPM using Essentia.js.
 * Reuses a single WASM instance to prevent memory leaks that cause
 * the process to die after a few hundred tracks. Console output is
 * suppressed during algorithm calls to avoid "undefined" lines.
 *
 * @returns Features or null if analysis fails / Essentia unavailable.
 */
export async function analyzeAudioWithEssentia(
  filePath: string
): Promise<EssentiaFeatures | null> {
  const essentia = getOrCreateEngine();
  if (!essentia) return null;

  const audio = await decodeAudioToFloat32(filePath);
  if (!audio || audio.length < 1000) return null;

  const origLog = console.log;
  console.log = () => {};
  try {
    const vector = essentia.arrayToVector(audio);

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
  } catch {
    return null;
  } finally {
    console.log = origLog;
  }
}
