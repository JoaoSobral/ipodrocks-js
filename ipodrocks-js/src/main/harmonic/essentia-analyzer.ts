/**
 * Audio analysis using Essentia.js for key and BPM detection.
 * Decodes audio via ffmpeg, runs KeyExtractor and RhythmExtractor2013.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
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

type EssentiaPkg = {
  Essentia: new (w: unknown) => {
    arrayToVector: (a: Float32Array) => unknown;
    KeyExtractor: (v: unknown) => { key: string; scale: string };
    RhythmExtractor2013: (v: unknown) => { bpm: number };
    shutdown: () => void;
  };
  EssentiaWASM: unknown;
};

let essentiaInstance: EssentiaPkg | null = null;

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
 * Decode audio file to mono Float32Array at 44100Hz using ffmpeg.
 */
function decodeAudioToFloat32(filePath: string): Float32Array | null {
  const tmpDir = os.tmpdir();
  const tmpWav = path.join(
    tmpDir,
    `ipodrocks-essentia-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );
  try {
    const ffmpegPath = getFfmpegPath();
    const result = spawnSync(
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
      { stdio: "pipe", encoding: "utf-8" }
    );
    if (result.status !== 0 || !fs.existsSync(tmpWav)) return null;
    const buf = fs.readFileSync(tmpWav);
    const decoded = wav.decode(buf);
    if (!decoded?.channelData?.length) return null;
    const mono = decoded.channelData[0] as Float32Array;
    return mono;
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav);
    } catch {
      // ignore
    }
  }
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
 * Returns null if analysis fails or Essentia is unavailable.
 */
export function analyzeAudioWithEssentia(
  filePath: string
): EssentiaFeatures | null {
  const pkg = getEssentia();
  if (!pkg) return null;

  const audio = decodeAudioToFloat32(filePath);
  if (!audio || audio.length < 1000) return null;

  try {
    const essentia = new pkg.Essentia(pkg.EssentiaWASM);
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

    essentia.shutdown();
    return { key, bpm, camelot };
  } catch {
    return null;
  }
}
