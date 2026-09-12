import { ChildProcess, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseFile } from "music-metadata";
import { getEncoderEnv } from "../utils/encoder-env";
import { getFfmpegPath } from "../utils/ffmpeg-path";
import { isMpcFile } from "../utils/audio-extensions";
import { readApeTags } from "../tagging/reader";
import type { ApeTags } from "../tagging/apev2/types";

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
  /**
   * When true and the codec is a lossy ffmpeg codec (mp3/aac/ogg/opus), encode
   * in variable-bitrate (VBR) mode targeting a quality level derived from
   * `bitrate` instead of using a fixed `-b:a` target. Ignored for all other
   * codecs (lossless and MPC have no CBR/VBR switch).
   */
  vbr?: boolean;
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

/**
 * Build an ASCII-safe temp path in the OS temp dir for encoder output. External
 * encoders (mpcenc) and some ffmpeg builds mishandle spaces/parentheses in output
 * paths, which now occur because we mirror source folder names 1:1 (issue #82).
 * We always encode here, then move to the real destination with Node's fs.
 */
export function makeSafeConversionTempPath(dest: string): string {
  const ext = path.extname(dest);
  const safeExt = /^\.[A-Za-z0-9]+$/.test(ext) ? ext : ".tmp";
  const rand = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `ipodrocks_conv_${Date.now()}_${rand}${safeExt}`);
}

/**
 * Move a finished conversion from the temp path to its final destination.
 * Falls back to copy+unlink when src and dest are on different filesystems
 * (rename throws EXDEV, e.g. OS temp dir vs the device mount).
 */
export function moveConvertedFile(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    } else {
      throw err;
    }
  }
}

function cleanupTemp(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** Codecs that support a variable-bitrate (VBR) encoding mode via ffmpeg. */
const VBR_CAPABLE_CODECS = new Set(["mp3", "aac", "ogg", "opus"]);

/**
 * Build ffmpeg args for VBR (variable-bitrate) encoding of a lossy codec,
 * mapping the chosen `bitrate` (kbps) to an equivalent quality target. Only
 * called for codecs in {@link VBR_CAPABLE_CODECS}.
 */
function vbrCodecArgs(codec: string, bitrate: number): string[] {
  switch (codec) {
    case "mp3": {
      // libmp3lame -q:a is the VBR (V) scale: 0 = best (~245k), 9 = smallest.
      const q =
        bitrate >= 320 ? 0 : bitrate >= 256 ? 1 : bitrate >= 192 ? 2 :
        bitrate >= 128 ? 5 : bitrate >= 96 ? 7 : 4;
      return ["-c:a", "mp3", "-q:a", String(q)];
    }
    case "ogg": {
      // libvorbis -q:a ranges -1..10, 10 = best quality.
      const q =
        bitrate >= 320 ? 9 : bitrate >= 256 ? 7 : bitrate >= 192 ? 6 :
        bitrate >= 128 ? 4 : bitrate >= 96 ? 2 : 3;
      return ["-c:a", "libvorbis", "-q:a", String(q)];
    }
    case "aac": {
      // Native ffmpeg aac VBR -q:a (~0.1..2.0), higher = better quality.
      const q =
        bitrate >= 256 ? "2" : bitrate >= 192 ? "1.6" : bitrate >= 128 ? "1.1" :
        bitrate >= 96 ? "0.7" : "1";
      return ["-c:a", "aac", "-q:a", q];
    }
    case "opus":
      // libopus is VBR-capable; keep the bitrate as the target and make VBR
      // explicit (it is the libopus default, but we set it for clarity).
      return ["-c:a", "libopus", "-b:a", `${bitrate}k`, "-vbr", "on"];
    default:
      return ["-c:a", "mp3", "-q:a", "2"];
  }
}

function buildFfmpegCommand(
  src: string,
  dest: string,
  settings: ConversionSettings
): string[] {
  const codec = settings.codec ?? "mp3";
  const bitrate = settings.bitrate ?? 256;

  const cmd = [getFfmpegPath(), "-y", "-i", src];

  if (settings.vbr && VBR_CAPABLE_CODECS.has(codec)) {
    cmd.push(...vbrCodecArgs(codec, bitrate));
  } else {
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
  }

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


/**
 * `runLoggedSubprocess` rejects with a plain `Error("Cancelled")` on abort — it
 * cannot construct a `SyncCancelled` without importing sync-core, which would
 * create a module cycle. Callers must therefore recognise cancellation by
 * message rather than by type.
 */
export function isCancellationError(err: unknown): boolean {
  return err instanceof Error && err.message === "Cancelled";
}

export function runLoggedSubprocess(
  cmd: string[],
  logCallback?: (line: string) => void,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number
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

    let timer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      proc.kill("SIGTERM");
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };

    // Optional watchdog. A malformed or maliciously oversized input (e.g. a
    // decompression-bomb cover image) can make ffmpeg allocate and spin for a
    // very long time before any output filter applies, which would otherwise
    // hang the whole sync with no way out but user cancellation.
    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        logCallback?.(`Timed out after ${timeoutMs}ms: ${cmd[0]}`);
      }, timeoutMs);
    }

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
      cleanup();
      reject(err);
    });

    proc.on("close", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

/**
 * ffmpeg's MOV/MP4 muxer silently drops any custom metadata key (confirmed
 * empirically — even an explicit per-stream `-metadata` override is dropped
 * on encode), so AAC/ALAC (`.m4a`) output needs the same explicit ReplayGain
 * write-back MPC gets via {@link writeMpcMetadata}. No-ops (and never touches
 * the file) when the source has no ReplayGain tags.
 */
async function maybeWriteM4aReplayGain(
  dest: string,
  srcPath: string,
  logCallback?: (line: string) => void
): Promise<void> {
  const sourceTags = await readSourceApeTags(srcPath);
  const rgTags = pickReplayGainForM4a(sourceTags.extra);
  if (Object.keys(rgTags).length === 0) return;

  const { writeM4aReplayGainTags } = await import("../tagging/mp4/replaygain-writer");
  const ok = writeM4aReplayGainTags(dest, rgTags);
  if (!ok) {
    logCallback?.("Warning: Could not write ReplayGain tags to M4A file (audio is fine)");
  }
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

  // Encode to an ASCII-safe temp path, then move to the (possibly space/paren
  // containing) final destination so encoders never see problem characters.
  const tmpDest = makeSafeConversionTempPath(dest);
  const codec = settings.codec ?? "mp3";

  try {
    let ok: boolean;
    if (codec === "mpc") {
      logCallback?.(`Converting to MPC: ${path.basename(src)}`);
      ok = await convertMusepack(
        src,
        tmpDest,
        settings.quality ?? 7,
        settings.metadata,
        logCallback,
        signal
      );
    } else {
      logCallback?.(`Converting to ${codec.toUpperCase()}: ${path.basename(src)}`);
      const cmd = buildFfmpegCommand(src, tmpDest, settings);
      const code = await runLoggedSubprocess(cmd, logCallback, signal);
      if (code !== 0) {
        logCallback?.(`Conversion error: ffmpeg exit ${code}`);
        ok = false;
      } else {
        ok = true;
      }
    }

    if (!ok) {
      cleanupTemp(tmpDest);
      return false;
    }

    if (codec === "aac" || codec === "alac") {
      await maybeWriteM4aReplayGain(tmpDest, src, logCallback);
    }

    moveConvertedFile(tmpDest, dest);
    logCallback?.(`Converted: ${path.basename(dest)}`);
    return true;
  } catch (err) {
    cleanupTemp(tmpDest);
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

  // Encode to an ASCII-safe temp path, then move to the final destination
  // (see makeSafeConversionTempPath rationale).
  const tmpDest = makeSafeConversionTempPath(dest);
  try {
    const cmd = buildProfileCommand(src, tmpDest, profile);
    const code = await runLoggedSubprocess(cmd, logCallback, signal);
    if (code !== 0) {
      throw new Error(`ffmpeg failed for ${path.basename(src)} (exit ${code})`);
    }

    if (ext === ".m4a") {
      await maybeWriteM4aReplayGain(tmpDest, src, logCallback);
    }

    moveConvertedFile(tmpDest, dest);
    logCallback?.(`Converted: ${path.basename(src)}`);
  } catch (err) {
    cleanupTemp(tmpDest);
    throw err;
  }
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

/** Strip NULs/newlines and trim, so tag values are single-line and clean. */
export function sanitizeTagText(value: string): string {
  return String(value).replace(/\0/g, "").replace(/\r?\n/g, " ").trim();
}

/**
 * Build the four standard ReplayGain tag values (APEv2/Vorbis-comment naming,
 * `"<n> dB"` for gain / bare ratio for peak — the format Rockbox's
 * `parse_replaygain()` expects across every container it reads) from
 * music-metadata's parsed `common` fields. Returns `undefined` when the
 * source has no ReplayGain tags at all.
 */
export function extractReplayGainTags(common: {
  replaygain_track_gain?: { dB: number };
  replaygain_track_peak?: { ratio: number };
  replaygain_album_gain?: { dB: number };
  replaygain_album_peak?: { ratio: number };
}): Record<string, string> | undefined {
  const tags: Record<string, string> = {};
  // music-metadata's toRatio() splits on a space, so a value written without
  // one ("-3.38dB") comes back as { dB: null }. Emitting that verbatim writes
  // the literal string "null dB" into the file, which is worse than writing
  // nothing: the ffprobe top-up below can still recover the real value.
  const setGain = (key: string, rg: { dB: number } | undefined) => {
    if (rg == null || !Number.isFinite(rg.dB)) return;
    tags[key] = `${rg.dB} dB`;
  };
  const setPeak = (key: string, rg: { ratio: number } | undefined) => {
    if (rg == null || !Number.isFinite(rg.ratio)) return;
    tags[key] = String(rg.ratio);
  };
  setGain("REPLAYGAIN_TRACK_GAIN", common.replaygain_track_gain);
  setPeak("REPLAYGAIN_TRACK_PEAK", common.replaygain_track_peak);
  setGain("REPLAYGAIN_ALBUM_GAIN", common.replaygain_album_gain);
  setPeak("REPLAYGAIN_ALBUM_PEAK", common.replaygain_album_peak);
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/** The four tag names, as written into the file, upper-cased for matching. */
const REPLAYGAIN_TAG_NAMES = new Set([
  "REPLAYGAIN_TRACK_GAIN",
  "REPLAYGAIN_TRACK_PEAK",
  "REPLAYGAIN_ALBUM_GAIN",
  "REPLAYGAIN_ALBUM_PEAK",
]);

const REPLAYGAIN_KEYS = [
  "replaygain_track_gain",
  "replaygain_track_peak",
  "replaygain_album_gain",
  "replaygain_album_peak",
] as const;

/**
 * Pick the ReplayGain entries out of an `ApeTags.extra` bucket (populated by
 * {@link readSourceApeTags}, whether via {@link extractReplayGainTags} for a
 * non-MPC source or via APEv2 passthrough for an MPC source), keyed
 * case-insensitively and normalized to the lowercase names MP4 freeform-atom
 * taggers conventionally use.
 */
export function pickReplayGainForM4a(
  extra: Record<string, string> | undefined
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!extra) return result;
  for (const [key, value] of Object.entries(extra)) {
    const lower = key.toLowerCase();
    if ((REPLAYGAIN_KEYS as readonly string[]).includes(lower)) {
      result[lower] = value;
    }
  }
  return result;
}

/**
 * Read tags directly from the source file and map them into APEv2 tag fields.
 * This is the MPC equivalent of ffmpeg's `-map_metadata 0`: since the MPC path
 * decodes through a tagless WAV, tags would otherwise be lost. Returns `{}` on
 * any parse failure so a corrupt source still yields an (untagged) MPC.
 */
export async function readSourceApeTags(srcPath: string): Promise<ApeTags> {
  // music-metadata's parseFile throws (and detaches an unhandled rejection) on
  // tagged SV8 MPC sources, so read APEv2 directly for Musepack inputs.
  if (isMpcFile(srcPath)) {
    try {
      return readApeTags(srcPath);
    } catch {
      return {};
    }
  }
  try {
    const { common } = await parseFile(srcPath);
    const tags: ApeTags = {};
    const set = (key: keyof ApeTags, value: string | undefined) => {
      if (value == null) return;
      const clean = sanitizeTagText(value);
      if (clean !== "") (tags as Record<string, unknown>)[key] = clean;
    };

    set("title", common.title);
    set("artist", common.artist);
    set("album", common.album);
    set("albumArtist", common.albumartist);
    set("genre", common.genre?.[0]);
    if (common.year != null && common.year > 0) set("year", String(common.year));
    if (common.originalyear != null && common.originalyear > 0) {
      set("originalYear", String(common.originalyear));
    }
    set("originalDate", common.originaldate);
    set("composer", common.composer?.join(", "));
    set("comment", common.comment?.[0]?.text);
    if (common.compilation === true) tags.compilation = "1";
    if (common.track?.no != null && common.track.no > 0) set("track", String(common.track.no));
    if (common.disk?.no != null && common.disk.no > 0) set("disc", String(common.disk.no));

    // ReplayGain reaches `common` only for the key spellings music-metadata's
    // per-container tables happen to list. When it comes back empty, ask
    // ffmpeg rather than concluding the file has none — the values are the
    // whole point of the tag for a Rockbox player, and issue #130 is what it
    // looks like when they quietly go missing. This costs one probe per track
    // that genuinely has no ReplayGain, which is small beside the encode that
    // follows it.
    const replayGain =
      extractReplayGainTags(common) ?? readReplayGainFromFile(srcPath);
    if (replayGain) tags.extra = replayGain;

    // Artwork is deliberately not read here: iPodRocks no longer embeds a
    // picture into the .mpc it writes (see writeMpcMetadata).

    return tags;
  } catch (err) {
    // Never swallow this. Returning {} is indistinguishable from "the source
    // had no tags", and that is exactly how issue #130 shipped: every tag the
    // DB does not carry — year, album artist, and all four ReplayGain values —
    // vanished from the transcode with nothing said. MetadataExtractor has
    // always logged and fallen back here; so does this now.
    console.warn(`⚠️  Could not read source tags from ${srcPath}:`, err);
    return readSourceTagsViaFfprobe(srcPath);
  }
}

/** Tags ffprobe reports, merged stream-then-format with format winning. */
function probeTagsViaFfprobe(srcPath: string): Record<string, string> | null {
  try {
    const result = spawnSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", srcPath],
      { encoding: "utf8", timeout: 5000, env: getEncoderEnv() }
    );
    if (result.status !== 0 || !result.stdout) return null;
    const probe = JSON.parse(result.stdout) as {
      format?: { tags?: Record<string, string> };
      streams?: Array<{ tags?: Record<string, string> }>;
    };
    const streamTags = probe.streams?.find((s) => s.tags)?.tags ?? {};
    return { ...streamTags, ...probe.format?.tags };
  } catch {
    return null;
  }
}

/**
 * The same, scraped from `ffmpeg -i`. Less precise than ffprobe's JSON, but
 * **ffmpeg is the binary this app ships** — only it is guaranteed to be there.
 * `ffprobe` is whatever the user happens to have installed, so it cannot be
 * the only way to read a tag the transcode depends on.
 */
function probeTagsViaFfmpeg(srcPath: string): Record<string, string> | null {
  try {
    // `-i` with no output is an error exit by design; the metadata still goes
    // to stderr, which is what we are here for.
    const result = spawnSync(getFfmpegPath(), ["-i", srcPath], {
      encoding: "utf8",
      timeout: 5000,
      env: getEncoderEnv(),
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (!out) return null;

    const tags: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      // Metadata lines are indented under a "Metadata:" header and padded to a
      // colon; "Duration:" and "Stream #0:0" sit at a shallower indent.
      const m = line.match(/^ {4,}([A-Za-z0-9_\-. ]+?)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1].trim();
      if (key === "" || key.startsWith("Stream")) continue;
      if (!(key in tags)) tags[key] = m[2].trim();
    }
    return Object.keys(tags).length > 0 ? tags : null;
  } catch {
    return null;
  }
}

/** Whatever tags an external probe can see, however it has to get them. */
function probeTags(srcPath: string): Record<string, string> | null {
  return probeTagsViaFfprobe(srcPath) ?? probeTagsViaFfmpeg(srcPath);
}

/**
 * The four ReplayGain values as an external probe sees them, matched
 * case-insensitively and passed through verbatim — the probe reports the raw
 * tag string, which is already the format Rockbox parses.
 */
export function readReplayGainFromFile(
  srcPath: string
): Record<string, string> | undefined {
  const tags = probeTags(srcPath);
  if (!tags) return undefined;

  const found: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    const upper = key.toUpperCase();
    if (!REPLAYGAIN_TAG_NAMES.has(upper)) continue;
    const clean = sanitizeTagText(String(value ?? ""));
    if (clean !== "") found[upper] = clean;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

/**
 * Last-resort tag read for a source music-metadata could not parse at all.
 * Covers much less than the parser does, but the alternative is a transcode
 * carrying only what the library database happens to know.
 */
function readSourceTagsViaFfprobe(srcPath: string): ApeTags {
  const probed = probeTags(srcPath);
  if (!probed) return {};

  // ffprobe's key case varies by container; normalize once and look up lower.
  const tags: ApeTags = {};
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(probed)) {
    if (value != null) lower[key.toLowerCase()] = String(value);
  }
  const set = (field: keyof ApeTags, ...keys: string[]) => {
    for (const key of keys) {
      const clean = sanitizeTagText(lower[key] ?? "");
      if (clean !== "") {
        (tags as Record<string, unknown>)[field] = clean;
        return;
      }
    }
  };

  set("title", "title");
  set("artist", "artist");
  set("album", "album");
  set("albumArtist", "album_artist", "albumartist");
  set("genre", "genre");
  set("composer", "composer");
  set("comment", "comment");
  // ffprobe reports a full date ("2001-05-01") and "3/12"-style counts; the
  // tag wants the leading number on its own.
  const leading = (value: string | undefined, len: number): string => {
    const match = sanitizeTagText(value ?? "").match(/^\d+/);
    return match && match[0].length <= len ? match[0] : "";
  };
  const year = leading(lower["date"] ?? lower["year"], 4);
  if (year !== "") tags.year = year;
  const track = leading(lower["track"], 4);
  if (track !== "") tags.track = track;
  const disc = leading(lower["disc"] ?? lower["discnumber"], 4);
  if (disc !== "") tags.disc = disc;

  const replayGain = readReplayGainFromFile(srcPath);
  if (replayGain) tags.extra = replayGain;

  return tags;
}

/**
 * Build the APEv2 tag set for an MPC file: start from the source file's tags,
 * then overlay the passed ConversionMetadata (DB values reflect user edits and
 * win for the fields they cover).
 */
export function buildMpcApeTags(
  sourceTags: ApeTags,
  metadata: ConversionMetadata | undefined
): ApeTags {
  const tags: ApeTags = { ...sourceTags };
  if (!metadata) return tags;

  if (metadata.title) tags.title = sanitizeTagText(metadata.title);
  if (metadata.artist) tags.artist = sanitizeTagText(metadata.artist);
  if (metadata.album) tags.album = sanitizeTagText(metadata.album);
  if (metadata.genre) tags.genre = sanitizeTagText(metadata.genre);
  if (metadata.year != null && metadata.year > 0) tags.year = String(metadata.year);
  if (metadata.trackNumber != null && metadata.trackNumber > 0) tags.track = String(metadata.trackNumber);
  if (metadata.discNumber != null && metadata.discNumber > 0) tags.disc = String(metadata.discNumber);

  return tags;
}

/**
 * Write metadata into an MPC file using APEv2 tags.
 * Uses the tagging module: strip existing tags, write new ones atomically.
 * Tags are read from the source file (so albumArtist/year/originalYear/etc. are
 * preserved) and merged with any explicit ConversionMetadata overrides.
 *
 * No artwork is written. Rockbox reads album art from the `cover.jpg` the
 * shadow build already generates beside the audio — resized to 300px by
 * `copyArtworkToShadowLibrary` — so embedding a second copy only added the
 * source image at its original resolution to every single file (issue #130:
 * 1500x1500 covers inside every track).
 */
async function writeMpcMetadata(
  mpcPath: string,
  srcPath: string,
  metadata: ConversionMetadata | undefined,
  logCallback?: (line: string) => void,
  _signal?: AbortSignal
): Promise<boolean> {
  const tags = buildMpcApeTags(await readSourceApeTags(srcPath), metadata);

  // Surfaced in the shadow-library build log on purpose. ReplayGain silently
  // not being there is the whole of issue #130, and "the source has none" and
  // "we failed to read it" were indistinguishable from outside the app.
  if (!tags.extra || Object.keys(tags.extra).length === 0) {
    logCallback?.(`No ReplayGain tags found in source: ${path.basename(srcPath)}`);
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
