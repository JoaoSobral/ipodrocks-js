import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ChildProcess } from "child_process";
import { getTempPath } from "../host";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { getEncoderEnv } from "../utils/encoder-env";
import { ffmpegInputArgs, runQuietFfmpeg } from "../utils/ffmpeg-input";
import { AUDIO_EXTENSIONS } from "../utils/audio-extensions";
import { encodePathToUrl, decodeUrlToPath } from "./media-url";
import type { PlaybackStrategy, Track } from "../../shared/types";

/**
 * All this module needs of a track, and deliberately no more.
 *
 * `ipc/player.ts` reads both fields off the `tracks` row rather than off the
 * request — narrowing the parameter is what makes that visible at the type
 * level, so a future caller cannot quietly hand the whole client-supplied
 * `Track` back in. See the note there for why that matters.
 */
export type PlayableSource = Pick<Track, "path" | "codec">;

export type { PlaybackStrategy };
export { encodePathToUrl, decodeUrlToPath };

const NATIVE_CODECS = new Set(["MP3", "AAC", "FLAC", "OGG", "OPUS", "PCM", "ALAC"]);

/**
 * In-flight transcodes, keyed by session.
 *
 * These were two module-level variables, which is correct for a desktop app
 * with exactly one window and wrong the moment a server has two clients: the
 * second person to press play killed the first person's ffmpeg and deleted the
 * file they were listening to. The desktop path is unchanged — it has one
 * session and so one entry.
 */
interface ActiveTranscode {
  proc: ChildProcess | null;
  tempFile: string | null;
}

const LOCAL_SESSION = "local";
const active = new Map<string, ActiveTranscode>();

/**
 * Hard wall-clock limit on one transcode. Vorbis at `-q:a 5` runs at tens of
 * times realtime, so this is hours of audio; what it exists to stop is a child
 * that will never finish. The per-session map above is no bound on its own —
 * a session is a login, and logging in again makes a new one — so the timeout
 * is what reaps a transcode nobody is waiting for any more.
 */
const DEFAULT_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;
let transcodeTimeoutMs = DEFAULT_TRANSCODE_TIMEOUT_MS;

/** Server-wide ceiling on concurrent player transcodes, across every session. */
export const MAX_CONCURRENT_PLAYER_TRANSCODES = 4;

/** A finished transcode nobody replaced is swept once it is this old. */
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/** Test hook: shorten the wall-clock limit. `undefined` restores the default. */
export function setPlayerTranscodeTimeoutForTests(ms: number | undefined): void {
  transcodeTimeoutMs = ms ?? DEFAULT_TRANSCODE_TIMEOUT_MS;
}

function runningTranscodes(): number {
  let n = 0;
  for (const entry of active.values()) if (entry.proc) n++;
  return n;
}

function unlinkQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or still held open on Windows.
  }
}

/**
 * Delete finished transcodes old enough that nobody can still be listening.
 * `cleanupPlayerTemp()` only runs from the Electron main process, so without
 * this a daemon kept one `.ogg` per abandoned session for as long as it ran.
 */
function sweepStaleTemp(tempDir: string): void {
  const live = new Set<string>();
  for (const entry of active.values()) if (entry.tempFile) live.add(entry.tempFile);
  const cutoff = Date.now() - STALE_TEMP_MS;
  try {
    for (const name of fs.readdirSync(tempDir)) {
      const full = path.join(tempDir, name);
      if (live.has(full)) continue;
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {
        // Raced with another sweep, or unreadable — leave it.
      }
    }
  } catch {
    // No temp dir yet.
  }
}

function getTempDir(): string {
  return path.join(getTempPath(), "ipodrocks-player");
}

export function getPlayerTempDir(): string {
  return getTempDir();
}

export function pickStrategy(track: PlayableSource): PlaybackStrategy {
  return NATIVE_CODECS.has(track.codec) ? "native" : "transcode";
}

export function isAudioFilePath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function cancelPrepare(sessionId?: string): Promise<void> {
  const key = sessionId ?? LOCAL_SESSION;
  const entry = active.get(key);
  if (!entry) return;
  active.delete(key);
  if (entry.proc) entry.proc.kill("SIGKILL");
  if (entry.tempFile) unlinkQuietly(entry.tempFile);
}

export async function prepareTrack(
  track: PlayableSource,
  forceTranscode = false,
  sessionId?: string
): Promise<{ url: string; strategy: PlaybackStrategy }> {
  await cancelPrepare(sessionId);

  const strategy = forceTranscode ? "transcode" : pickStrategy(track);

  if (strategy === "native") {
    return { url: encodePathToUrl(track.path, sessionId), strategy };
  }

  // Counted before this session's own entry exists, and after its previous
  // one was cancelled above, so a session replacing its own track never
  // counts against itself.
  if (runningTranscodes() >= MAX_CONCURRENT_PLAYER_TRANSCODES) {
    throw new Error("The server is busy converting other tracks. Try again in a moment.");
  }

  const tempDir = getTempDir();
  fs.mkdirSync(tempDir, { recursive: true });
  sweepStaleTemp(tempDir);

  const id = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(tempDir, `${id}.ogg`);
  const key = sessionId ?? LOCAL_SESSION;
  const entry: ActiveTranscode = { proc: null, tempFile };
  active.set(key, entry);

  // The same restricted input every other ffmpeg call uses (see
  // utils/ffmpeg-input.ts). `forceTranscode` is a client choice, so this branch
  // runs for any library file whatever its codec — it must not be able to
  // open anything but that file.
  const args = [
    "-y",
    ...ffmpegInputArgs(track.path),
    "-c:a", "libvorbis", "-q:a", "5",
    "-map", "0:a", "-vn",
    tempFile,
  ];

  const outcome = await runQuietFfmpeg(getFfmpegPath(), args, {
    timeoutMs: transcodeTimeoutMs,
    env: getEncoderEnv(),
    onSpawn: (proc) => {
      entry.proc = proc;
    },
  });
  entry.proc = null;

  if (outcome.kind !== "exited" || outcome.code !== 0) {
    // Only tidy up if the entry is still ours: a cancel (or the session's next
    // prepare) may already have replaced it and removed the file.
    if (active.get(key) === entry) active.delete(key);
    unlinkQuietly(tempFile);
    if (outcome.kind === "timeout") {
      throw new Error(`ffmpeg did not finish within ${Math.round(transcodeTimeoutMs / 1000)}s`);
    }
    if (outcome.kind === "spawn-error") throw outcome.error;
    if (outcome.kind === "aborted") throw new Error("Cancelled");
    throw new Error(
      `ffmpeg exited with code ${outcome.code}` +
        (outcome.stderrTail ? `: ${outcome.stderrTail.split("\n").pop()}` : "")
    );
  }

  return { url: encodePathToUrl(tempFile, sessionId), strategy };
}

export function cleanupPlayerTemp(): void {
  const tempDir = getTempDir();
  try {
    if (fs.existsSync(tempDir)) {
      for (const file of fs.readdirSync(tempDir)) {
        try { fs.unlinkSync(path.join(tempDir, file)); } catch {}
      }
    }
  } catch {}
  active.clear();
}
