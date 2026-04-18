import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getEncoderEnv } from "../utils/encoder-env";

let cachedFfmpegPath: string | null = null;

/**
 * Returns the path to the FFmpeg binary. Uses @ffmpeg-installer/ffmpeg in dev;
 * in packaged app uses the binary from extraResources.
 */
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

/** Metadata to write into converted files (e.g. MPC). */
export interface ConversionMetadata {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
}

export interface ConversionSettings {
  codec?: string;
  bitrate?: number;
  quality?: number;
  transfer_mode?: string;
  rule_applied?: string;
  /** Metadata to embed in the output (used for MPC and other codecs that need explicit tag write-back). */
  metadata?: ConversionMetadata;
}

const CODEC_EXT_MAP: Record<string, string> = {
  mp3: ".mp3",
  alac: ".m4a",
  flac: ".flac",
  ogg: ".ogg",
  opus: ".opus",
  mpc: ".mpc",
  ape: ".ape",
  aac: ".m4a",
};

const PROFILE_EXT_MAP: Record<string, string> = {
  aac_256: ".m4a",
  alac_16: ".m4a",
};

export function updateExtension(filePath: string, codec: string): string {
  const ext = CODEC_EXT_MAP[codec] ?? ".mp3";
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, parsed.name + ext);
}

function buildFfmpegCommand(
  src: string,
  dest: string,
  settings: ConversionSettings
): string[] {
  const codec = settings.codec ?? "mp3";
  const bitrate = settings.bitrate ?? 256;

  const cmd = [getFfmpegPath(), "-y", "-i", src];

  const codecArgs: Record<string, string[]> = {
    mp3: ["-c:a", "mp3", "-b:a", `${bitrate}k`],
    aac: ["-c:a", "aac", "-b:a", `${bitrate}k`],
    alac:
      bitrate >= 1000
        ? ["-c:a", "alac", "-q:a", "0"]
        : ["-c:a", "alac", "-b:a", `${bitrate}k`],
    flac: ["-c:a", "flac", "-compression_level", "8"],
    ogg: ["-c:a", "libvorbis", "-b:a", `${bitrate}k`],
    opus: ["-c:a", "libopus", "-b:a", `${bitrate}k`],
  };

  cmd.push(...(codecArgs[codec] ?? ["-c:a", "mp3", "-b:a", `${bitrate}k`]));

  if (codec === "opus" || codec === "ogg") {
    cmd.push("-map", "0:a", "-map_metadata", "0");
  } else {
    cmd.push("-c:v", "copy", "-map_metadata", "0");
  }

  cmd.push(dest);
  return cmd;
}

function buildProfileCommand(
  src: string,
  dest: string,
  profile: string
): string[] {
  const profiles: Record<string, string[]> = {
    aac_256: ["-c:a", "aac", "-b:a", "256k"],
    alac_16: ["-c:a", "alac", "-sample_fmt", "s16p"],
    default: ["-c:a", "mp3", "-b:a", "256k"],
  };

  const cmd = [getFfmpegPath(), "-y", "-i", src];
  cmd.push(...(profiles[profile] ?? profiles["default"]));
  cmd.push(
    "-map", "0:a",
    "-map", "0:v?",
    "-map_metadata", "0",
    "-c:v", "copy"
  );
  cmd.push(dest);
  return cmd;
}


function runLoggedSubprocess(
  cmd: string[],
  logCallback?: (line: string) => void,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cancelled"));
      return;
    }

    let proc: ChildProcess;
    try {
      proc = spawn(cmd[0], cmd.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: env ?? process.env,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const onAbort = (): void => {
      proc.kill("SIGTERM");
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handleOutput = (data: Buffer): void => {
      const lines = data.toString("utf-8").split(/\r?\n/);
      for (const line of lines) {
        const stripped = line.trimEnd();
        if (stripped && logCallback) logCallback(stripped);
      }
    };

    proc.stdout?.on("data", handleOutput);
    proc.stderr?.on("data", handleOutput);

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(code ?? 1);
    });
  });
}

export async function convertWithCodec(
  src: string,
  dest: string,
  settings: ConversionSettings,
  logCallback?: (line: string) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });

  const codec = settings.codec ?? "mp3";
  if (codec === "mpc") {
    logCallback?.(`Converting to MPC: ${path.basename(src)}`);
    const quality = settings.quality ?? 7;
    const metadata = settings.metadata;
    try {
      return await convertMusepack(
        src,
        dest,
        quality,
        metadata,
        logCallback,
        signal
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT") || msg.includes("spawn mpcenc")) {
        logCallback?.(
          "mpcenc not found. Install mpc-tools (Arch) or musepack-tools and ensure mpcenc is in PATH."
        );
      }
      logCallback?.(`Conversion error: ${msg}`);
      return false;
    }
  }

  logCallback?.(`Converting to ${codec.toUpperCase()}: ${path.basename(src)}`);

  try {
    const cmd = buildFfmpegCommand(src, dest, settings);
    const code = await runLoggedSubprocess(cmd, logCallback, signal);
    if (code !== 0) {
      logCallback?.(`Conversion error: ffmpeg exit ${code}`);
      return false;
    }
    logCallback?.(`Converted: ${path.basename(dest)}`);
    return true;
  } catch (err) {
    logCallback?.(`Conversion error: ${err}`);
    return false;
  }
}

export async function convertWithFfmpeg(
  src: string,
  dest: string,
  profile: string,
  logCallback?: (line: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true });

  const ext = PROFILE_EXT_MAP[profile] ?? ".mp3";
  const parsed = path.parse(dest);
  dest = path.join(parsed.dir, parsed.name + ext);

  logCallback?.(`Converting (profile ${profile}): ${path.basename(src)}`);

  const cmd = buildProfileCommand(src, dest, profile);
  const code = await runLoggedSubprocess(cmd, logCallback, signal);
  if (code !== 0) {
    throw new Error(`ffmpeg failed for ${path.basename(src)} (exit ${code})`);
  }
  logCallback?.(`Converted: ${path.basename(src)}`);
}

async function convertMusepack(
  src: string,
  dest: string,
  quality: number,
  metadata: ConversionMetadata | undefined,
  logCallback?: (line: string) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const os = await import("os");
  const tmpWav = path.join(
    os.tmpdir(),
    `ipodrocks_mpc_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
  );

  try {
    const ffmpegCmd = [
      getFfmpegPath(), "-y", "-i", src,
      "-f", "wav", "-acodec", "pcm_s16le",
      "-ar", "44100", "-ac", "2",
      tmpWav,
    ];
    const ffmpegCode = await runLoggedSubprocess(ffmpegCmd, logCallback, signal);
    if (ffmpegCode !== 0) {
      logCallback?.(`FFmpeg error: exit ${ffmpegCode}`);
      return false;
    }

    const mpcencCmd = [
      "mpcenc", "--silent",
      "--quality", `${quality}.0`,
      tmpWav, dest,
    ];
    const mpcCode = await runLoggedSubprocess(mpcencCmd, logCallback, signal, getEncoderEnv());
    if (mpcCode !== 0) {
      logCallback?.(`mpcenc error: exit ${mpcCode}`);
      return false;
    }

    const tagged = await writeMpcMetadata(dest, src, metadata, logCallback, signal);
    if (!tagged) {
      logCallback?.("Warning: Could not write metadata to MPC file (audio is fine)");
    }

    logCallback?.(`Converted to Musepack Q${quality}: ${path.basename(dest)}`);
    return true;
  } finally {
    try { fs.unlinkSync(tmpWav); } catch { /* ignore */ }
  }
}

/**
 * Write metadata into an MPC file using APEv2 tags.
 * Uses the tagging module: strip existing tags, write new ones atomically.
 */
async function writeMpcMetadata(
  mpcPath: string,
  srcPath: string,
  metadata: ConversionMetadata | undefined,
  logCallback?: (line: string) => void,
  _signal?: AbortSignal
): Promise<boolean> {
  if (!metadata) return true;

  const tags: import("../tagging/apev2/types").ApeTags = {};
  if (metadata.title) tags.title = String(metadata.title).replace(/\0/g, "").replace(/\r?\n/g, " ").trim();
  if (metadata.artist) tags.artist = String(metadata.artist).replace(/\0/g, "").replace(/\r?\n/g, " ").trim();
  if (metadata.album) tags.album = String(metadata.album).replace(/\0/g, "").replace(/\r?\n/g, " ").trim();
  if (metadata.genre) tags.genre = String(metadata.genre).replace(/\0/g, "").replace(/\r?\n/g, " ").trim();
  if (metadata.year != null && metadata.year > 0) tags.year = String(metadata.year);
  if (metadata.trackNumber != null && metadata.trackNumber > 0) tags.track = String(metadata.trackNumber);
  if (metadata.discNumber != null && metadata.discNumber > 0) tags.disc = String(metadata.discNumber);

  const albumDir = path.dirname(srcPath);
  const coverNames = ["cover.jpg", "cover.jpeg", "cover.png"];
  for (const name of coverNames) {
    const coverPath = path.join(albumDir, name);
    try {
      if (fs.existsSync(coverPath)) {
        const data = fs.readFileSync(coverPath);
        const ext = path.extname(name).toLowerCase();
        tags.coverArt = {
          data,
          mimeType: ext === ".png" ? "image/png" : "image/jpeg",
          filename: name,
        };
        break;
      }
    } catch {
      /* skip if unreadable */
    }
  }

  try {
    const { writeTags } = await import("../tagging/writer");
    await writeTags(mpcPath, tags);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logCallback?.(`APEv2 tag write failed: ${msg}`);
    return false;
  }
}

export function estimateConvertedSize(
  originalSize: number,
  codec: string,
  bitrate: number
): number {
  let ratio: number;
  switch (codec) {
    case "mp3":
      ratio = bitrate <= 96 ? 0.15 : bitrate <= 128 ? 0.2 : bitrate <= 192 ? 0.3 : bitrate <= 256 ? 0.4 : 0.5;
      break;
    case "opus":
      ratio = bitrate <= 96 ? 0.12 : bitrate <= 128 ? 0.16 : bitrate <= 192 ? 0.22 : 0.28;
      break;
    case "aac":
      ratio = bitrate <= 96 ? 0.2 : bitrate <= 128 ? 0.25 : bitrate <= 192 ? 0.3 : 0.35;
      break;
    case "flac":
    case "alac":
      ratio = 0.6;
      break;
    case "mpc":
      ratio = bitrate <= 2 ? 0.12 : bitrate <= 4 ? 0.15 : bitrate <= 6 ? 0.18 : 0.22;
      break;
    default:
      ratio = 1.0;
  }
  return Math.floor(originalSize * ratio);
}
