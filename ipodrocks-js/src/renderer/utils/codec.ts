import type { CodecConfig } from "../ipc/api";

/** Lossy codecs that support a variable-bitrate (VBR) encoding mode. */
const VBR_CAPABLE_CODECS = new Set(["MP3", "AAC", "OGG", "OPUS"]);

/**
 * Whether a codec supports a VBR toggle. Lossless codecs (FLAC/ALAC/PCM) are
 * always variable and MPC is already quality-based, so they are excluded.
 */
export function isVbrCapableCodec(codecName: string | null | undefined): boolean {
  return VBR_CAPABLE_CODECS.has((codecName ?? "").toUpperCase());
}

/**
 * Returns codec configs that can be used for transcoding (excludes DIRECT COPY,
 * and optionally MPC when mpcenc is unavailable).
 */
export function getTranscodableCodecConfigs(
  codecConfigs: CodecConfig[] | undefined,
  mpcAvailable: boolean
): CodecConfig[] {
  const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
  return configs
    .filter((cc) => (cc?.codec_name ?? "").toUpperCase() !== "DIRECT COPY")
    .filter(
      (cc) =>
        mpcAvailable || (cc?.codec_name ?? "").toUpperCase() !== "MPC"
    );
}
