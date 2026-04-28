import type { CodecConfig } from "../ipc/api";
import type { ShadowLibrary } from "@shared/types";

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function formatBitrate(bps: number): string {
  if (!bps) return "—";
  const kbps = bps / 1000;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function formatCodecLabel(cc: CodecConfig): string {
  const codec = (cc?.codec_name ?? "").toUpperCase();
  if (codec === "DIRECT COPY" || codec === "COPY") {
    return `${codec} - ${cc.name}`;
  }
  let detail = "";
  if (cc.bitrate_value != null) {
    detail = `(${cc.bitrate_value}kbps)`;
  } else if (cc.quality_value != null) {
    detail = `(Q${cc.quality_value})`;
  } else if (cc.bits_per_sample != null) {
    detail = `(${cc.bits_per_sample}-bit)`;
  }
  return `${codec} - ${cc.name}${detail ? ` ${detail}` : ""}`;
}

export function formatShadowCodecLabel(cc: CodecConfig): string {
  const codec = (cc?.codec_name ?? "").toUpperCase();
  let detail = "";
  if (cc?.bitrate_value != null) detail = `(${cc.bitrate_value}kbps)`;
  else if (cc?.quality_value != null) detail = `(Q${cc.quality_value})`;
  else if (cc?.bits_per_sample != null) detail = `(${cc.bits_per_sample}-bit)`;
  return `${codec} - ${cc?.name ?? ""}${detail ? ` ${detail}` : ""}`;
}

export function formatShadowCodecAndBitrate(sl: ShadowLibrary): string {
  const codec = (sl.codecName ?? "").toUpperCase();
  let detail = "";
  if (sl.codecBitrateValue != null) detail = `${sl.codecBitrateValue}kbps`;
  else if (sl.codecQualityValue != null) detail = `Q${sl.codecQualityValue}`;
  else if (sl.codecBitsPerSample != null) detail = `${sl.codecBitsPerSample}-bit`;
  return detail ? `${codec}, ${detail}` : codec || "—";
}

export function formatShadowSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0.0 GB";
  const gb = bytes / 1e9;
  return `${gb.toFixed(1)} GB`;
}
