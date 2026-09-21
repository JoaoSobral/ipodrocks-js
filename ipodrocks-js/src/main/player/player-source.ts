import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { getTempPath } from "../host";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { getEncoderEnv } from "../utils/encoder-env";
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
  if (entry.tempFile) {
    try {
      fs.unlinkSync(entry.tempFile);
    } catch {
      // Already gone, or still held open on Windows.
    }
  }
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

  const tempDir = getTempDir();
  fs.mkdirSync(tempDir, { recursive: true });

  const id = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(tempDir, `${id}.ogg`);
  const key = sessionId ?? LOCAL_SESSION;
  const entry: ActiveTranscode = { proc: null, tempFile };
  active.set(key, entry);

  const ffmpeg = getFfmpegPath();
  const args = [
    "-y", "-i", track.path,
    "-c:a", "libvorbis", "-q:a", "5",
    "-map", "0:a", "-vn",
    tempFile,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { env: getEncoderEnv() });
    entry.proc = proc;
    proc.on("close", (code) => {
      entry.proc = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", (err) => {
      entry.proc = null;
      reject(err);
    });
  });

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
