import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { app } from "electron";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { getEncoderEnv } from "../utils/encoder-env";
import { AUDIO_EXTENSIONS } from "../utils/audio-extensions";
import type { PlaybackStrategy, Track } from "../../shared/types";

export type { PlaybackStrategy };

const NATIVE_CODECS = new Set(["MP3", "AAC", "FLAC", "OGG", "OPUS", "PCM", "ALAC"]);

let activeFfmpegProcess: ChildProcess | null = null;
let activeTempFile: string | null = null;

function getTempDir(): string {
  return path.join(app.getPath("temp"), "ipodrocks-player");
}

export function getPlayerTempDir(): string {
  return getTempDir();
}

export function pickStrategy(track: Track): PlaybackStrategy {
  return NATIVE_CODECS.has(track.codec) ? "native" : "transcode";
}

export function isAudioFilePath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function encodePathToUrl(filePath: string): string {
  return `media://local/${Buffer.from(filePath, "utf8").toString("base64url")}`;
}

export function decodeUrlToPath(url: string): string {
  const u = new URL(url);
  return Buffer.from(u.pathname.slice(1), "base64url").toString("utf8");
}

export async function cancelPrepare(): Promise<void> {
  if (activeFfmpegProcess) {
    activeFfmpegProcess.kill("SIGKILL");
    activeFfmpegProcess = null;
  }
  if (activeTempFile) {
    try { fs.unlinkSync(activeTempFile); } catch {}
    activeTempFile = null;
  }
}

export async function prepareTrack(
  track: Track,
  forceTranscode = false,
): Promise<{ url: string; strategy: PlaybackStrategy }> {
  await cancelPrepare();

  const strategy = forceTranscode ? "transcode" : pickStrategy(track);

  if (strategy === "native") {
    return { url: encodePathToUrl(track.path), strategy };
  }

  const tempDir = getTempDir();
  fs.mkdirSync(tempDir, { recursive: true });

  const id = crypto.randomBytes(8).toString("hex");
  const tempFile = path.join(tempDir, `${id}.ogg`);
  activeTempFile = tempFile;

  const ffmpeg = getFfmpegPath();
  const args = [
    "-y", "-i", track.path,
    "-c:a", "libvorbis", "-q:a", "5",
    "-map", "0:a", "-vn",
    tempFile,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { env: getEncoderEnv() });
    activeFfmpegProcess = proc;
    proc.on("close", (code) => {
      activeFfmpegProcess = null;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", (err) => {
      activeFfmpegProcess = null;
      reject(err);
    });
  });

  return { url: encodePathToUrl(tempFile), strategy };
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
}
