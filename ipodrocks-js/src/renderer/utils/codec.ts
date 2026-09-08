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

/**
 * Whether to show the "mpcenc is not installed" reminder.
 *
 * Every input arrives from its own IPC round trip, and they resolve in whatever
 * order they resolve. The reminder is shown once per session and latched, so
 * deciding on incomplete information is not recoverable — a user who ticked
 * "don't remind me" saw the modal anyway whenever that preference happened to
 * answer last. `remindDisabled: null` therefore means "not known yet", and is
 * never treated as "not disabled".
 */
export function shouldRemindMpcUnavailable(opts: {
  codecConfigs: CodecConfig[] | undefined;
  /** Result of the mpcenc probe. */
  mpcAvailable: boolean;
  /** The stored preference, or null while it is still being read. */
  remindDisabled: boolean | null;
}): boolean {
  if (opts.remindDisabled !== false) return false;
  if (opts.mpcAvailable) return false;
  const configs = Array.isArray(opts.codecConfigs) ? opts.codecConfigs : [];
  return configs.some((c) => (c?.codec_name ?? "").toUpperCase() === "MPC");
}
