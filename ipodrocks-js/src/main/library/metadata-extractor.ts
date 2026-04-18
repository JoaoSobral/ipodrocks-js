/**
 * Audio metadata extraction using the music-metadata library.
 *
 * Ported from Python's MetadataExtractor (mutagen) — music-metadata provides
 * a unified API across all formats, replacing the per-format branch logic.
 */

import path from "path";
import { spawnSync } from "child_process";
import { parseFile } from "music-metadata";
import { normalizeKey, toCamelot } from "../harmonic/camelotWheel";
import { getEncoderEnv } from "../utils/encoder-env";

/** Tag metadata extracted from an audio file. */
export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  genre: string;
  trackNumber: string;
  discNumber: string;
  showTitle?: string;
  episodeNumber?: string;
}

/** Key, BPM, and Camelot for harmonic mixing (Savant). */
export interface AudioFeatures {
  key: string | null;
  bpm: number | null;
  camelot: string | null;
}

/** Technical audio properties of a file. */
export interface AudioInfo {
  duration: number;
  bitrate: number;
  bitsPerSample: number | null;
  codec: string;
  sampleRate: number;
}

const CODEC_MAP: Record<string, string> = {
  aac: "AAC",
  alac: "ALAC",
  mp3: "MP3",
  "mpeg 1 layer 3": "MP3",
  flac: "FLAC",
  ogg: "OGG",
  vorbis: "OGG",
  opus: "OPUS",
  pcm: "PCM",
  wav: "PCM",
  aiff: "PCM",
  mpc: "MPC",
  musepack: "MPC",
  "musepack, sv7": "MPC",
  "musepack, sv8": "MPC",
  ape: "APE",
  "monkey's audio": "APE",
};

const EXT_CODEC_MAP: Record<string, string> = {
  ".mp3": "MP3",
  ".opus": "OPUS",
  ".aac": "AAC",
  ".m4a": "AAC",
  ".ogg": "OGG",
  ".flac": "FLAC",
  ".wav": "PCM",
  ".aiff": "PCM",
  ".aif": "PCM",
};

const LOSSLESS_CODECS = new Set(["FLAC", "ALAC", "PCM", "WAV", "AIFF"]);

/**
 * Extracts metadata and audio info from audio files using the music-metadata
 * library. Replaces all per-format Python/mutagen branches with a single
 * unified API.
 */
export class MetadataExtractor {
  /**
   * Extract tag metadata from an audio file.
   * @param filePath  Absolute path to the audio file
   * @param contentType  "music", "podcast", or "audiobook"
   * @returns Normalised tag metadata with defaults for missing fields
   */
  async extractMetadata(
    filePath: string,
    contentType: string = "music"
  ): Promise<TrackMetadata> {
    try {
      const metadata = await parseFile(filePath);
      const { common } = metadata;
      const stem = path.basename(filePath, path.extname(filePath));

      const title = common.title || stem;
      const artist = common.artist || "Unknown Artist";
      const album = common.album || "Unknown Album";
      const genre = common.genre?.[0] || "Unknown Genre";
      const trackNumber = common.track?.no?.toString() ?? "";
      const discNumber = common.disk?.no?.toString() ?? "";

      if (contentType === "podcast" || contentType === "audiobook") {
        const showTitle = common.album || "";
        return {
          title,
          artist,
          album,
          genre,
          trackNumber,
          discNumber,
          showTitle,
          episodeNumber: trackNumber,
        };
      }

      return { title, artist, album, genre, trackNumber, discNumber };
    } catch (err) {
      console.warn(`⚠️  Error reading metadata from ${filePath}:`, err);
      const stem = path.basename(filePath, path.extname(filePath));
      const fallback = this.extractMetadataViaFfprobe(filePath, stem, contentType);
      if (fallback) return fallback;
      return {
        title: stem,
        artist: "Unknown Artist",
        album: "Unknown Album",
        genre: "Unknown Genre",
        trackNumber: "",
        discNumber: "",
      };
    }
  }

  /**
   * Extract key, BPM, and Camelot for harmonic mixing (Savant playlists).
   * Reads TKEY and TBPM from ID3/native tags via music-metadata.
   */
  async extractAudioFeatures(filePath: string): Promise<AudioFeatures> {
    try {
      const metadata = await parseFile(filePath, {
        skipCovers: true,
        duration: false,
      });
      const native = metadata.native as Record<
        string,
        Array<{ id: string; value?: unknown }>
      > | undefined;
      let rawKey: string | null = null;
      if (native) {
        for (const format of ["ID3v2.4", "ID3v2.3", "ID3v2.2"]) {
          const tags = native[format];
          if (tags) {
            const tkey = tags.find((t) => t.id === "TKEY");
            if (tkey?.value != null) {
              rawKey = String(tkey.value);
              break;
            }
          }
        }
      }
      const rawBpm = metadata.common.bpm ?? null;
      const key = normalizeKey(rawKey);
      return {
        key,
        bpm: rawBpm ? Math.round(rawBpm * 10) / 10 : null,
        camelot: toCamelot(key),
      };
    } catch {
      return { key: null, bpm: null, camelot: null };
    }
  }

  /**
   * Extract technical audio information from a file.
   * @param filePath  Absolute path to the audio file
   * @returns Duration, bitrate, codec, sample rate, and bits per sample
   */
  async extractAudioInfo(filePath: string): Promise<AudioInfo> {
    try {
      const metadata = await parseFile(filePath);
      const fmt = metadata.format;
      const ext = path.extname(filePath).toLowerCase();

      let codec = this.normalizeCodec(fmt.codec ?? "", ext);

      if (
        (codec === "AAC" || ext === ".m4a") &&
        fmt.codec &&
        fmt.codec.toLowerCase().includes("alac")
      ) {
        codec = "ALAC";
      }

      const bitsPerSample = this.extractBitDepth(
        fmt.bitsPerSample ?? null,
        codec
      );

      const duration = fmt.duration ?? 0;
      const bitrate = fmt.bitrate ?? 0;

      if (!duration || !bitrate) {
        const fallback = this.extractAudioInfoViaFfprobe(filePath);
        if (fallback && (fallback.duration || fallback.bitrate)) {
          return {
            duration: duration || fallback.duration,
            bitrate: bitrate || fallback.bitrate,
            bitsPerSample: bitsPerSample ?? fallback.bitsPerSample,
            codec: codec !== "Unknown" ? codec : fallback.codec,
            sampleRate: fmt.sampleRate ?? fallback.sampleRate,
          };
        }
      }

      return {
        duration,
        bitrate,
        bitsPerSample,
        codec,
        sampleRate: fmt.sampleRate ?? 0,
      };
    } catch (err) {
      console.warn(`⚠️  Error reading audio info from ${filePath}:`, err);
      const fallback = this.extractAudioInfoViaFfprobe(filePath);
      if (fallback) return fallback;
      return {
        duration: 0,
        bitrate: 0,
        bitsPerSample: null,
        codec: "Unknown",
        sampleRate: 0,
      };
    }
  }

  private extractAudioInfoViaFfprobe(filePath: string): AudioInfo | null {
    try {
      const result = spawnSync(
        "ffprobe",
        ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
        { encoding: "utf8", timeout: 5000, env: getEncoderEnv() }
      );
      if (result.error) {
        console.warn(`⚠️  ffprobe spawn error for ${filePath}:`, result.error);
        return null;
      }
      if (result.status !== 0 || !result.stdout) {
        console.warn(`⚠️  ffprobe failed (status=${result.status}) for ${filePath}`, result.stderr?.slice(0, 200));
        return null;
      }
      const probe = JSON.parse(result.stdout) as {
        format?: { duration?: string; bit_rate?: string };
        streams?: Array<{ codec_name?: string; sample_rate?: string; duration?: string; bit_rate?: string }>;
      };
      const fmt = probe.format ?? {};
      const stream = probe.streams?.[0] ?? {};
      const ext = path.extname(filePath).toLowerCase();
      const codec = this.normalizeCodec(stream.codec_name ?? "", ext);
      const durationStr = fmt.duration ?? stream.duration;
      const bitrateStr = fmt.bit_rate ?? stream.bit_rate;
      const info: AudioInfo = {
        duration: durationStr ? parseFloat(durationStr) : 0,
        bitrate: bitrateStr ? parseInt(bitrateStr, 10) : 0,
        bitsPerSample: this.extractBitDepth(null, codec),
        codec,
        sampleRate: stream.sample_rate ? parseInt(stream.sample_rate, 10) : 0,
      };
      return info;
    } catch (err) {
      console.warn(`⚠️  ffprobe parse error for ${filePath}:`, err);
      return null;
    }
  }

  private extractMetadataViaFfprobe(
    filePath: string,
    stem: string,
    contentType: string
  ): TrackMetadata | null {
    try {
      const result = spawnSync(
        "ffprobe",
        ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
        { encoding: "utf8", timeout: 5000, env: getEncoderEnv() }
      );
      if (result.status !== 0 || !result.stdout) return null;
      const probe = JSON.parse(result.stdout) as {
        format?: { tags?: Record<string, string> };
      };
      const tags = probe.format?.tags ?? {};
      const title = tags.title || tags.TITLE || stem;
      const artist = tags.artist || tags.ARTIST || "Unknown Artist";
      const album = tags.album || tags.ALBUM || "Unknown Album";
      const genre = tags.genre || tags.GENRE || "Unknown Genre";
      const trackNumber = tags.track || tags.TRACK || "";
      const discNumber = tags.disc || tags.DISC || "";
      if (contentType === "podcast" || contentType === "audiobook") {
        return { title, artist, album, genre, trackNumber, discNumber, showTitle: album, episodeNumber: trackNumber };
      }
      return { title, artist, album, genre, trackNumber, discNumber };
    } catch {
      return null;
    }
  }

  /**
   * Normalise a raw codec string to a canonical uppercase name.
   * Falls back to extension-based lookup when the string is empty or unknown.
   */
  private normalizeCodec(raw: string, ext: string): string {
    if (raw) {
      const lower = raw.toLowerCase();
      if (CODEC_MAP[lower]) return CODEC_MAP[lower];
      for (const [key, value] of Object.entries(CODEC_MAP)) {
        if (lower.includes(key)) return value;
      }
    }
    return EXT_CODEC_MAP[ext] ?? "Unknown";
  }

  /**
   * Derive bits-per-sample, returning null for lossy formats.
   * Defaults to 16 for lossless formats where the value is unavailable.
   */
  private extractBitDepth(
    bitsPerSample: number | null,
    codec: string
  ): number | null {
    if (!LOSSLESS_CODECS.has(codec.toUpperCase())) return null;
    return bitsPerSample ?? 16;
  }
}
