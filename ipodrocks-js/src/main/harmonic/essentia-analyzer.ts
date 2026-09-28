/**
 * Audio analysis using Essentia.js for key and BPM detection.
 *
 * Two stages, and neither may run unbounded on the main thread:
 *
 * 1. **Decode** — ffmpeg writes up to 120 s of mono 44.1 kHz WAV to a temp
 *    file. It runs through `runQuietFfmpeg()` (stdio never left undrained, a
 *    hard wall-clock limit, killed on abort) with the restricted input of
 *    `utils/ffmpeg-input.ts`. The old spawn left stderr as an unread pipe, so
 *    a file whose metadata dump outgrew the pipe blocked ffmpeg in `write(2)`
 *    forever, the promise never settled, and the backfill — and its cancel —
 *    wedged for the life of the process.
 * 2. **Analysis** — in `essentia-worker.ts`, on a `worker_threads` Worker. See
 *    that file for why. A track that outlives its time limit, or a cancel,
 *    terminates the worker; the next track gets a fresh one.
 *
 * Both stages honour an `AbortSignal`, so cancelling a backfill interrupts the
 * track in flight instead of waiting for it.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Worker } from "worker_threads";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { getEncoderEnv } from "../utils/encoder-env";
import { ffmpegInputArgs, runQuietFfmpeg } from "../utils/ffmpeg-input";
import type { EssentiaWorkerRequest, EssentiaWorkerResponse } from "./essentia-worker";

export interface EssentiaFeatures {
  key: string | null;
  bpm: number | null;
  camelot: string | null;
}

/**
 * Essentia itself could not be loaded, or its worker could not start. A fact
 * about the installation, not the track — the backfill stops on it rather than
 * marking every remaining track as unanalysable.
 */
export class EssentiaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EssentiaUnavailableError";
  }
}

/** Decoding two minutes of audio takes well under a second; this is a wedge detector. */
const DECODE_TIMEOUT_MS = 60_000;
/** Key + rhythm extraction over two minutes of audio is a few seconds. */
const DEFAULT_ANALYSIS_TIMEOUT_MS = 90_000;

let analysisTimeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS;
let decodeTimeoutMs = DECODE_TIMEOUT_MS;
let workerScriptOverride: string | null = null;

/** Test hooks. `undefined` restores the default. */
export function setEssentiaTimeoutsForTests(opts: { decodeMs?: number; analysisMs?: number }): void {
  decodeTimeoutMs = opts.decodeMs ?? DECODE_TIMEOUT_MS;
  analysisTimeoutMs = opts.analysisMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS;
}

/**
 * Point the worker at a prebuilt script. Under vitest this module is the `.ts`
 * source and there is no compiled `essentia-worker.js` beside it, so a test
 * bundles one and hands its path in here.
 */
export function setEssentiaWorkerScriptForTests(scriptPath: string | null): void {
  workerScriptOverride = scriptPath;
  terminateWorker();
}

function workerScriptPath(): string {
  return workerScriptOverride ?? path.join(__dirname, "essentia-worker.js");
}

let worker: Worker | null = null;
let nextRequestId = 1;

function terminateWorker(): void {
  const w = worker;
  worker = null;
  if (w) void w.terminate().catch(() => {});
}

/** Stop the analysis worker, if one is running. Idempotent. */
export function resetEssentiaEngine(): void {
  terminateWorker();
}

function getWorker(): Worker {
  if (worker) return worker;
  const script = workerScriptPath();
  if (!fs.existsSync(script)) {
    throw new EssentiaUnavailableError(`Essentia worker script not found at ${script}`);
  }
  const w = new Worker(script);
  // The worker must never keep the process alive on its own.
  w.unref();
  w.on("error", () => {
    if (worker === w) worker = null;
  });
  w.on("exit", () => {
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

/**
 * Decode audio to a mono 44.1 kHz WAV temp file with ffmpeg. Returns its path,
 * or null when the file could not be decoded, the decode timed out, or it was
 * cancelled — and in every null case the temp file is already gone.
 */
async function decodeToWav(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const tmpWav = path.join(os.tmpdir(), `ipodrocks-essentia-${crypto.randomUUID()}.wav`);
  const outcome = await runQuietFfmpeg(
    getFfmpegPath(),
    [
      "-y",
      ...ffmpegInputArgs(filePath),
      "-f", "wav",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", "44100",
      "-t", "120",
      tmpWav,
    ],
    { timeoutMs: decodeTimeoutMs, signal, env: getEncoderEnv() }
  );
  if (outcome.kind === "exited" && outcome.code === 0 && fs.existsSync(tmpWav)) {
    return tmpWav;
  }
  removeQuietly(tmpWav);
  return null;
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

/** Run one analysis on the worker, bounded by the time limit and the signal. */
function analyzeOnWorker(
  wavPath: string,
  signal?: AbortSignal
): Promise<EssentiaFeatures | null> {
  let w: Worker;
  try {
    w = getWorker();
  } catch (err) {
    return Promise.reject(err);
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
      fn();
    };
    const onMessage = (msg: EssentiaWorkerResponse): void => {
      if (msg?.id !== id) return;
      if (msg.unavailable) {
        done(() => reject(new EssentiaUnavailableError("essentia.js could not be loaded")));
        return;
      }
      done(() => resolve(msg.result));
    };
    const onError = (err: Error): void => {
      done(() => reject(new EssentiaUnavailableError(`Essentia worker failed: ${err.message}`)));
    };
    const onExit = (): void => {
      // Exited without answering and without an error: it was terminated,
      // which only this module does — treat as a failed track.
      done(() => resolve(null));
    };
    const onAbort = (): void => {
      terminateWorker();
      done(() => resolve(null));
    };
    const timer = setTimeout(() => {
      // Too long: the WASM is interrupted where it stands. The track is
      // reported as failed and the next one gets a fresh worker.
      terminateWorker();
      done(() => resolve(null));
    }, analysisTimeoutMs);

    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const req: EssentiaWorkerRequest = { id, wavPath };
    w.postMessage(req);
  });
}

/**
 * Analyze audio file for key and BPM using Essentia.js.
 *
 * @returns Features, or null when this track could not be analysed (undecodable,
 *   too short, timed out, or cancelled — check the signal to tell the last
 *   apart).
 * @throws EssentiaUnavailableError when Essentia cannot run at all.
 */
export async function analyzeAudioWithEssentia(
  filePath: string,
  opts: { signal?: AbortSignal } = {}
): Promise<EssentiaFeatures | null> {
  const wavPath = await decodeToWav(filePath, opts.signal);
  if (!wavPath) return null;
  try {
    return await analyzeOnWorker(wavPath, opts.signal);
  } finally {
    removeQuietly(wavPath);
  }
}
