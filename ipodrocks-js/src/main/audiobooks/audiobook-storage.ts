import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export function getAudiobooksRoot(): string {
  return path.join(app.getPath("userData"), "auto-audiobooks");
}

export function getChapterDir(librivoxId: number): string {
  return path.join(getAudiobooksRoot(), String(librivoxId));
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
