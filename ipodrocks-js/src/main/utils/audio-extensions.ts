import path from "path";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif",
  ".ogg", ".opus", ".ape", ".mpc", ".mpp",
]);

/** Musepack file extensions — the formats affected by the music-metadata SV8 bug. */
const MPC_EXTENSIONS = new Set([".mpc", ".mpp"]);

export function isMpcFile(filePath: string): boolean {
  return MPC_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// macOS writes AppleDouble sidecar files (e.g. "._05 Mirage.ogg") to non-HFS+
// volumes (FAT32/exFAT/network). They share the audio extension but contain
// no audio — skip them wherever we walk a directory.
export function isMacosMetadataFile(name: string): boolean {
  return name.startsWith("._");
}
