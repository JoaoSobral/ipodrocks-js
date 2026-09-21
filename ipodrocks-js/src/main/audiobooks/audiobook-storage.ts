import * as fs from "fs";
import * as path from "path";
import { getUserDataPath } from "../host";

export function getAudiobooksRoot(): string {
  return path.join(getUserDataPath(), "auto-audiobooks");
}

/**
 * A LibriVox id is the one path component every audiobook file operation is
 * built from, and it arrives over IPC. `librivox_id INTEGER NOT NULL` does not
 * coerce it: SQLite's INTEGER affinity leaves a value that is not a well-formed
 * integer literal stored as TEXT, so `"../../.."` comes back out as a string and
 * `path.join` resolves it straight out of the audiobooks root. `unsubscribe()`
 * then `rmSync`s that directory recursively. Validate here, because this is the
 * single function every caller goes through.
 */
export function assertLibrivoxId(librivoxId: unknown): number {
  const n = typeof librivoxId === "number" ? librivoxId : Number(librivoxId);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`invalid LibriVox id: ${String(librivoxId)}`);
  }
  return n;
}

export function getChapterDir(librivoxId: number): string {
  return path.join(getAudiobooksRoot(), String(assertLibrivoxId(librivoxId)));
}

export function getChapterPath(librivoxId: number, chapterId: number, ext: string): string {
  const cleanExt = ext.startsWith(".") ? ext : `.${ext}`;
  return path.join(getChapterDir(librivoxId), `${chapterId}${cleanExt}`);
}

export function ensureChapterDir(librivoxId: number): void {
  fs.mkdirSync(getChapterDir(librivoxId), { recursive: true });
}

export function getCoverPath(librivoxId: number, ext = ".jpg"): string {
  const cleanExt = ext.startsWith(".") ? ext : `.${ext}`;
  return path.join(getChapterDir(librivoxId), `cover${cleanExt}`);
}
