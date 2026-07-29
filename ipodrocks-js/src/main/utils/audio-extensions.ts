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

// Trash / recycle-bin directory names. A scanned folder may contain a deleted
// copy of a track (e.g. inside ".Trash-1000/files/…"); we must not index those
// copies as real library tracks. Matched by EXACT directory name (not a
// substring) so legitimate folders like "Trash Talk/" are still scanned.
//
// The dotless "trash" spelling matters: the freedesktop.org spec puts the user
// trash at "~/.local/share/Trash/files/", and NAS shares add their own vendor
// names ("#recycle" on Synology, "@Recycle" on QNAP) that appear at the root of
// a mounted music share.
const TRASH_DIR_NAMES = new Set([
  "trash",
  ".trashes",
  "$recycle.bin",
  "recycle.bin",
  "recycler",
  "recycled",
  "#recycle",
  "@recycle",
  ".recycle",
]);

export function isTrashDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  // ".Trash", ".Trashes", ".Trash-1000" (Linux XDG per-uid trash)
  if (/^\.trash(es)?(-\d+)?$/.test(lower)) return true;
  // "Trash-1000" also occurs without the leading dot on some SMB exports.
  if (/^trash(es)?(-\d+)?$/.test(lower)) return true;
  return TRASH_DIR_NAMES.has(lower);
}
