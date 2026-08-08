/**
 * Verification predicate for the shadow-library reconciliation pass.
 *
 * When a shadow library is (re)built we first check which destination files are
 * already on disk and genuinely encoded the way this library's codec
 * configuration says they should be. Files that verify are adopted — seeded
 * into `shadow_tracks` as 'synced' — so the existing skip logic in
 * `_transcodeTrack` leaves them alone instead of re-encoding hours of audio
 * over byte-equivalent output.
 *
 * This module is deliberately pure: no database, no filesystem. The matching
 * rules are the part most likely to be wrong, so they are testable in complete
 * isolation. See `shadow-library.ts` for the pass that drives it.
 */
import type { AudioInfo } from "./metadata-extractor";

/**
 * Accepted deviation from a configured CBR target. Encoders do not hit a
 * nominal bitrate exactly — container overhead, embedded artwork and encoder
 * padding all shift the measured figure — so an exact compare would reject
 * files we ourselves produced.
 */
export const BITRATE_TOLERANCE = 0.15;

/**
 * Codecs whose measured bitrate is worth comparing against the configured
 * target, i.e. the ones that actually encode at a constant bitrate.
 *
 * Everything else here is a *quality* target in disguise. Measured against
 * output from this pipeline's own encoder settings:
 *
 *          pure sine (easy)   pink noise (hard)   target
 *   MP3        320                 320             320   <- honours it
 *   AAC        105                 215             256
 *   Opus        99                  95             128
 *
 * ffmpeg's native AAC encoder and libopus treat `-b:a` as an average to aim
 * for and spend far less on compressible material. The legitimate range
 * therefore overlaps the wrong-setting range — a quiet AAC track measured 41%
 * of nominal, while a 128k file in a 320k library is 40% — so no window can
 * separate them. For those codecs we verify identity by duration instead.
 */
export const CBR_RELIABLE_CODECS = new Set(["MP3"]);

/**
 * Accepted difference between the shadow file's duration and the source
 * track's, in seconds. Encoder padding and container rounding shift this by
 * well under a second; anything larger means a truncated file or a different
 * recording entirely.
 */
export const DURATION_TOLERANCE_SEC = 2;

/**
 * Codecs verified by name alone, because this pipeline does not control their
 * bit depth: `buildFfmpegCommand` passes no `-sample_fmt` for flac/alac, so
 * output depth always equals *source* depth regardless of what
 * `codec_configurations.bits_per_sample` claims. A "FLAC 16" config fed 24-bit
 * sources legitimately produces 24-bit FLACs, so checking depth here would
 * reject nearly every file in a mixed library.
 */
export const LOSSLESS_CODECS = new Set(["FLAC", "ALAC", "PCM", "APE"]);

/**
 * Targets we refuse to reconcile at all. 'DIRECT COPY' has no deterministic
 * encoder mapping (it falls through to mp3 in `buildFfmpegCommand`), and
 * 'Unknown' is not a real target. The renderer filters DIRECT COPY out of the
 * shadow UI, but the `shadow:create` IPC handler does not, so such a library is
 * constructible and must be handled here.
 */
export const UNRECONCILABLE_CODECS = new Set(["DIRECT COPY", "UNKNOWN"]);

/** What a shadow library's codec configuration expects its files to be. */
export interface CodecMatchTarget {
  /** `codecs.name`, e.g. "OPUS". Compared case-insensitively. */
  codecName: string;
  /** `codec_configurations.bitrate_value`, in kbps. NULL for quality-based configs. */
  bitrateKbps: number | null;
  /** `codec_configurations.quality_value`, e.g. MPC Q5. */
  qualityValue: number | null;
  /** `shadow_libraries.vbr_enabled` — VBR output bitrate is content-dependent. */
  vbrEnabled: boolean;
  /**
   * Duration of the *source* track in seconds, or null when unknown. This is
   * the identity check that carries the weight for quality-targeting codecs:
   * it confirms the file is the right recording, at full length.
   */
  sourceDurationSec: number | null;
}

export type MatchResult = { ok: true } | { ok: false; reason: string };

/** Tally of what one reconciliation pass did. */
export interface ShadowReconcileResult {
  /** File verified on disk with no (or a stale-path) row — row seeded 'synced'. */
  adopted: number;
  /** Row deleted because the file it pointed at is gone. */
  dropped: number;
  /** File present at the destination but the wrong format — will be re-encoded. */
  rejected: number;
  /** Row trusted without probing because the stored size+mtime still match. */
  verified: number;
  /** Legacy row with NULL stat given a baseline, without probing. */
  backfilled: number;
  /** Files actually opened and parsed. */
  probed: number;
  /** Pass was aborted partway. */
  cancelled: boolean;
  /** Pass did not run at all (missing root, or an unreconcilable codec). */
  skipped: boolean;
}

export function emptyReconcileResult(): ShadowReconcileResult {
  return {
    adopted: 0,
    dropped: 0,
    rejected: 0,
    verified: 0,
    backfilled: 0,
    probed: 0,
    cancelled: false,
    skipped: false,
  };
}

/**
 * Decide whether an already-present file matches what this shadow library would
 * have encoded.
 *
 * Fails closed: anything we cannot positively confirm is rejected and gets
 * re-encoded, which costs CPU but never leaves a wrongly-encoded file in place.
 *
 * @param info   Probe result. `info.bitrate` is in BITS per second and
 *               `info.duration` in seconds — the music-metadata / ffprobe
 *               convention.
 * @param target What the library's codec configuration expects.
 */
export function audioMatchesCodecConfig(
  info: Pick<AudioInfo, "codec" | "bitrate" | "duration">,
  target: CodecMatchTarget
): MatchResult {
  const want = target.codecName.trim().toUpperCase();

  if (UNRECONCILABLE_CODECS.has(want)) {
    return { ok: false, reason: `codec ${target.codecName} is not reconcilable` };
  }

  // An unreadable or corrupt file probes as "Unknown", which never equals a
  // real configuration name — so it fails here and gets re-encoded.
  const got = (info.codec ?? "").trim().toUpperCase();
  if (got !== want) {
    return { ok: false, reason: `codec ${got || "?"} ≠ ${want}` };
  }

  // Identity: is this the right recording, at full length? Catches truncated
  // and half-written files, and a stale file left by a differently-organised
  // library. Skipped when either side's duration is unknown rather than
  // guessed at.
  if (
    target.sourceDurationSec != null &&
    target.sourceDurationSec > 0 &&
    info.duration > 0
  ) {
    const drift = Math.abs(info.duration - target.sourceDurationSec);
    if (drift > DURATION_TOLERANCE_SEC) {
      return {
        ok: false,
        reason: `duration ${info.duration.toFixed(1)}s ≠ source ${target.sourceDurationSec.toFixed(1)}s`,
      };
    }
  }

  // Bit depth is not ours to control — see LOSSLESS_CODECS.
  if (LOSSLESS_CODECS.has(want)) return { ok: true };

  // VBR output tracks content, not the nominal figure the config carries.
  if (target.vbrEnabled) return { ok: true };

  // Quality-based configs (MPC Qn) have no bitrate to compare against.
  if (target.bitrateKbps == null) return { ok: true };

  // Quality-targeting encoders undershoot legitimately — see
  // CBR_RELIABLE_CODECS. Duration above is what verifies these.
  if (!CBR_RELIABLE_CODECS.has(want)) return { ok: true };

  const gotKbps = info.bitrate / 1000;
  if (!Number.isFinite(gotKbps) || gotKbps <= 0) {
    return { ok: false, reason: "no readable bitrate" };
  }

  const lo = target.bitrateKbps * (1 - BITRATE_TOLERANCE);
  const hi = target.bitrateKbps * (1 + BITRATE_TOLERANCE);
  if (gotKbps < lo || gotKbps > hi) {
    return {
      ok: false,
      reason: `${Math.round(gotKbps)} kbps outside ${Math.round(lo)}–${Math.round(hi)} kbps`,
    };
  }

  return { ok: true };
}

/**
 * True when existence at the deterministic destination path is already as much
 * evidence as a probe would give, so the file should not be opened.
 *
 * Only MPC qualifies today, and it matters: `extractAudioInfo` routes .mpc
 * through `readAudioOnly`, which does a *synchronous* `fs.readFileSync` of the
 * entire file (tagging/mpc/strip.ts) — probing an MPC shadow library would
 * block the main process for a full read of every track. Nothing is lost by
 * skipping: `.mpc` is unambiguous in CODEC_EXT_MAP, and MPC configs are
 * quality-based, so there is no nominal bitrate to verify anyway.
 *
 * `.m4a` deliberately does not qualify — aac and alac share that extension, so
 * only a probe can tell them apart.
 */
export function canSkipProbe(target: CodecMatchTarget): boolean {
  return target.codecName.trim().toUpperCase() === "MPC";
}
