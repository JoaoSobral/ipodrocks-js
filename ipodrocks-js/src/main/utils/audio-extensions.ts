export const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".m4a", ".flac", ".wav", ".aiff", ".aif",
  ".ogg", ".opus", ".ape", ".mpc", ".mpp",
]);

// macOS writes AppleDouble sidecar files (e.g. "._05 Mirage.ogg") to non-HFS+
// volumes (FAT32/exFAT/network). They share the audio extension but contain
// no audio — skip them wherever we walk a directory.
export function isMacosMetadataFile(name: string): boolean {
  return name.startsWith("._");
}
