import type { CodecConfig } from "../ipc/api";

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
