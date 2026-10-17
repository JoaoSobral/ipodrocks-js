/**
 * The lossless check: is this FLAC/ALAC/WAV/AIFF really lossless audio, or a
 * lossy file wearing a lossless container?
 *
 * Two passes, so a whole library stays cheap:
 *
 * - **Light** — one 20 s window from 30% into every in-scope track, frames
 *   back to back. Enough to see a lossy encoder's wall; never enough to call a
 *   file lossy on its own, so it only says genuine / possibly lossy.
 * - **Deep** — only for the light pass's suspects: six 20 s windows spread
 *   across the track, half-overlapping frames, plus the per-frame consistency
 *   test that tells an encoder's wall from a natural roll-off.
 *
 * Decoding is ffmpeg (`decodePcmF32`, restricted input, bounded), measuring is
 * Essentia on its worker (`computeFrameBandsWithEssentia`), deciding is the
 * pure `spectral-verdict.ts`. Every verdict is written as soon as it is known,
 * so a cancelled run keeps what it finished.
 */
import type Database from "better-sqlite3";
import { parseFile } from "music-metadata";
import type {
  LosslessProgress,
  LosslessReportRow,
  LosslessScanOptions,
  LosslessScanResult,
  LosslessVerdict,
} from "../../shared/types";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { getEncoderEnv } from "../utils/encoder-env";
import { decodePcmF32 } from "../utils/ffmpeg-input";
import {
  computeFrameBandsWithEssentia,
  EssentiaUnavailableError,
} from "../harmonic/essentia-analyzer";
import {
  BAND_HZ,
  classifyDeep,
  classifyLight,
  concatFrameBands,
  type FrameBands,
  type LosslessResult,
} from "./spectral-verdict";

/** Codec names (as `codecs.name` stores them) the check applies to. */
export const LOSSLESS_CHECK_CODECS: readonly string[] = [
  "FLAC", "ALAC", "PCM", "WAV", "AIFF", "APE", "WAVPACK", "WV", "TTA",
];

const WINDOW_SECONDS = 20;
const LIGHT_START_SHARE = 0.3;
const DEEP_WINDOWS = 6;
/** Hi-res above this is decoded at this rate; nothing a lossy encoder does lives higher. */
const MAX_DECODE_RATE = 96_000;
const DECODE_TIMEOUT_MS = 60_000;

interface CandidateRow {
  id: number;
  path: string;
  duration: number | null;
}

interface AudioShape {
  sampleRate: number;
  duration: number;
}

const codecList = LOSSLESS_CHECK_CODECS.map((c) => `'${c}'`).join(",");

function selectCandidates(db: Database.Database, scope: LosslessScanOptions["scope"]): CandidateRow[] {
  return db
    .prepare(
      `SELECT t.id, t.path, t.duration
         FROM tracks t
         JOIN codecs c ON c.id = t.codec_id
        WHERE UPPER(c.name) IN (${codecList})
          AND t.content_type = 'music'
          AND COALESCE(t.lossless_override, 0) = 0
          ${scope === "unchecked" ? "AND t.lossless_verdict IS NULL" : ""}
        ORDER BY t.path`
    )
    .all() as CandidateRow[];
}

async function probeShape(filePath: string, fallbackDuration: number | null): Promise<AudioShape | null> {
  try {
    const meta = await parseFile(filePath, { duration: false, skipCovers: true });
    const sampleRate = meta.format.sampleRate ?? 0;
    const duration = meta.format.duration ?? fallbackDuration ?? 0;
    if (!sampleRate) return null;
    return { sampleRate, duration };
  } catch {
    return null;
  }
}

async function measureWindow(
  filePath: string,
  shape: AudioShape,
  startSec: number,
  seconds: number,
  overlap: boolean,
  signal: AbortSignal
): Promise<FrameBands | null> {
  const rate = Math.min(shape.sampleRate, MAX_DECODE_RATE);
  const args = ["-t", seconds.toFixed(3)];
  if (rate !== shape.sampleRate) args.push("-ar", String(rate));
  const outcome = await decodePcmF32(
    getFfmpegPath(),
    { filePath, seekSeconds: startSec },
    args,
    {
      timeoutMs: DECODE_TIMEOUT_MS,
      // One extra second of slack: ffmpeg's -t is frame-accurate, not sample-exact.
      maxBytes: Math.ceil((seconds + 1) * rate * 4),
      signal,
      env: getEncoderEnv(),
    }
  );
  if (outcome.kind !== "ok") return null;
  return computeFrameBandsWithEssentia(outcome.samples, rate, { bandHz: BAND_HZ, overlap, signal });
}

async function runLight(filePath: string, shape: AudioShape, signal: AbortSignal): Promise<LosslessResult> {
  const seconds = Math.min(WINDOW_SECONDS, shape.duration || WINDOW_SECONDS);
  const start = shape.duration > WINDOW_SECONDS * 1.5 ? shape.duration * LIGHT_START_SHARE : 0;
  return classifyLight(await measureWindow(filePath, shape, start, seconds, false, signal));
}

async function runDeep(filePath: string, shape: AudioShape, signal: AbortSignal): Promise<LosslessResult> {
  const parts: FrameBands[] = [];
  if (!shape.duration || shape.duration <= WINDOW_SECONDS * DEEP_WINDOWS) {
    const whole = await measureWindow(filePath, shape, 0, shape.duration || WINDOW_SECONDS * DEEP_WINDOWS, true, signal);
    if (whole) parts.push(whole);
  } else {
    const span = shape.duration - WINDOW_SECONDS;
    for (let i = 0; i < DEEP_WINDOWS && !signal.aborted; i++) {
      const part = await measureWindow(filePath, shape, (span * i) / (DEEP_WINDOWS - 1), WINDOW_SECONDS, true, signal);
      if (part) parts.push(part);
    }
  }
  return classifyDeep(concatFrameBands(parts));
}

function writeVerdict(db: Database.Database, trackId: number, r: LosslessResult): void {
  const details = r.metrics
    ? JSON.stringify({
        cliffDb: r.metrics.cliffDb,
        depthDb: r.metrics.depthDb,
        emptyShare: r.metrics.emptyShare,
        sampleRate: r.metrics.sampleRate,
        loudFrames: r.metrics.loudFrames,
      })
    : null;
  db.prepare(
    `UPDATE tracks
        SET lossless_verdict = ?, lossless_confidence = ?, lossless_cutoff_hz = ?,
            lossless_source = ?, lossless_stage = ?, lossless_details = ?,
            lossless_checked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND COALESCE(lossless_override, 0) = 0`
  ).run(r.verdict, r.confidence, r.cutoffHz, r.source, r.stage, details, trackId);
}

/**
 * Check every in-scope track. Resolves with counts; never throws for a single
 * bad file (it becomes `inconclusive`). Stops early, with `error` set, only
 * when Essentia itself cannot run.
 */
export async function runLosslessScan(
  db: Database.Database,
  opts: LosslessScanOptions,
  onProgress: (p: LosslessProgress) => void,
  signal: AbortSignal
): Promise<LosslessScanResult> {
  const deep = opts.deep !== false;
  const candidates = selectCandidates(db, opts.scope);
  const counts: Partial<Record<LosslessVerdict, number>> = {};
  const bump = (v: LosslessVerdict, by = 1): void => {
    counts[v] = (counts[v] ?? 0) + by;
  };
  const suspects: { row: CandidateRow; shape: AudioShape }[] = [];
  let checked = 0;
  let deepChecked = 0;

  const finish = (phase: "complete" | "cancelled" | "error", error?: string): LosslessScanResult => {
    onProgress({
      phase,
      processed: phase === "complete" ? candidates.length : checked,
      total: candidates.length,
      suspects: suspects.length,
      message: error,
    });
    // No `error` key at all on success: structured clone keeps an undefined
    // property, and a client testing `"error" in result` would read failure.
    const result: LosslessScanResult = { checked, deepChecked, counts, cancelled: phase === "cancelled" };
    if (error) result.error = error;
    return result;
  };

  try {
    for (const row of candidates) {
      if (signal.aborted) return finish("cancelled");
      onProgress({ phase: "light", processed: checked, total: candidates.length, suspects: suspects.length, path: row.path });
      const shape = await probeShape(row.path, row.duration);
      const result: LosslessResult = shape
        ? await runLight(row.path, shape, signal)
        : { verdict: "inconclusive", confidence: 0, cutoffHz: null, source: null, stage: "light", metrics: null };
      if (signal.aborted) return finish("cancelled");
      checked++;
      // A suspect waits for the deep pass to decide it; without one, the light
      // pass's "possibly lossy" is the answer.
      if (result.verdict === "possibly_lossy" && deep && shape) {
        suspects.push({ row, shape });
      } else {
        writeVerdict(db, row.id, result);
        bump(result.verdict);
      }
      onProgress({
        phase: "light",
        processed: checked,
        total: candidates.length,
        suspects: suspects.length,
        path: row.path,
        verdict: result.verdict,
      });
    }

    for (const { row, shape } of suspects) {
      if (signal.aborted) return finish("cancelled");
      onProgress({ phase: "deep", processed: deepChecked, total: suspects.length, suspects: suspects.length, path: row.path });
      const result = await runDeep(row.path, shape, signal);
      if (signal.aborted) return finish("cancelled");
      writeVerdict(db, row.id, result);
      bump(result.verdict);
      deepChecked++;
      onProgress({
        phase: "deep",
        processed: deepChecked,
        total: suspects.length,
        suspects: suspects.length,
        path: row.path,
        verdict: result.verdict,
      });
    }
  } catch (err) {
    if (err instanceof EssentiaUnavailableError) return finish("error", err.message);
    throw err;
  }
  return finish("complete");
}

interface ReportRow {
  id: number;
  title: string | null;
  filename: string;
  artist: string;
  album: string;
  path: string;
  codec: string;
  lossless_verdict: LosslessVerdict;
  lossless_confidence: number | null;
  lossless_cutoff_hz: number | null;
  lossless_source: string | null;
  lossless_stage: "light" | "deep" | null;
  lossless_details: string | null;
  lossless_override: number | null;
  lossless_checked_at: string | null;
}

/** Every checked track, most damning first. `verdicts` narrows it. */
export function getLosslessReport(
  db: Database.Database,
  verdicts?: readonly LosslessVerdict[]
): LosslessReportRow[] {
  const filter = verdicts && verdicts.length ? `AND t.lossless_verdict IN (${verdicts.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.filename, t.path,
              COALESCE(a.name, 'Unknown Artist') AS artist,
              COALESCE(al.title, 'Unknown Album') AS album,
              COALESCE(c.name, 'Unknown') AS codec,
              t.lossless_verdict, t.lossless_confidence, t.lossless_cutoff_hz,
              t.lossless_source, t.lossless_stage, t.lossless_details,
              t.lossless_override, t.lossless_checked_at
         FROM tracks t
         LEFT JOIN artists a ON a.id = t.artist_id
         LEFT JOIN albums al ON al.id = t.album_id
         LEFT JOIN codecs c ON c.id = t.codec_id
        WHERE t.lossless_verdict IS NOT NULL ${filter}
        ORDER BY CASE t.lossless_verdict
                   WHEN 'lossy_strong' THEN 0 WHEN 'lossy' THEN 1 WHEN 'upsampled' THEN 2
                   WHEN 'possibly_lossy' THEN 3 WHEN 'inconclusive' THEN 4 ELSE 5 END,
                 artist, album, t.path`
    )
    .all(...(verdicts ?? [])) as ReportRow[];
  return rows.map((r) => {
    let details: { cliffDb?: number; depthDb?: number; emptyShare?: number } = {};
    try {
      details = r.lossless_details ? JSON.parse(r.lossless_details) : {};
    } catch {
      details = {};
    }
    return {
      trackId: r.id,
      title: r.title || r.filename,
      artist: r.artist,
      album: r.album,
      path: r.path,
      codec: r.codec,
      verdict: r.lossless_verdict,
      confidence: r.lossless_confidence,
      cutoffHz: r.lossless_cutoff_hz,
      source: r.lossless_source,
      stage: r.lossless_stage,
      cliffDb: details.cliffDb ?? null,
      depthDb: details.depthDb ?? null,
      emptyShare: details.emptyShare ?? null,
      override: r.lossless_override === 1,
      checkedAt: r.lossless_checked_at,
    };
  });
}

/** "Mark as OK": the user overrules the verdict; re-checks skip the track. */
export function setLosslessOverride(db: Database.Database, trackIds: number[], ok: boolean): number {
  const stmt = db.prepare("UPDATE tracks SET lossless_override = ? WHERE id = ?");
  let changed = 0;
  db.transaction(() => {
    for (const id of trackIds) changed += stmt.run(ok ? 1 : 0, id).changes;
  })();
  return changed;
}

/** Forget verdicts (all, or the given tracks) so the next check re-measures them. */
export function clearLosslessVerdicts(db: Database.Database, trackIds?: number[]): number {
  const sql = `UPDATE tracks
                  SET lossless_verdict = NULL, lossless_confidence = NULL, lossless_cutoff_hz = NULL,
                      lossless_source = NULL, lossless_stage = NULL, lossless_details = NULL,
                      lossless_checked_at = NULL, lossless_override = 0`;
  if (!trackIds) return db.prepare(sql + " WHERE lossless_verdict IS NOT NULL OR lossless_override = 1").run().changes;
  const stmt = db.prepare(sql + " WHERE id = ?");
  let changed = 0;
  db.transaction(() => {
    for (const id of trackIds) changed += stmt.run(id).changes;
  })();
  return changed;
}
