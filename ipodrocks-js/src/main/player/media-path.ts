import * as fs from "fs";
import * as path from "path";
import { getPlayerTempDir, isAudioFilePath } from "./player-source";
import { getAudiobooksRoot } from "../audiobooks/audiobook-storage";

/**
 * What a media request is allowed to read, in one place.
 *
 * This used to live inside `media-protocol.ts`'s `protocol.handle` callback,
 * which meant the HTTP media route would have had to restate it — and a second
 * copy of a path-containment check is a second chance to get it subtly
 * different. The `media://` handler and `/api/media/:token` now call the same
 * function, so the two transports cannot disagree about what is servable.
 */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isUnder(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep) || child.startsWith(parent + "/");
}

export function isAudiobookCoverPath(resolvedPath: string): boolean {
  const ext = path.extname(resolvedPath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return false;
  // Resolve symlinks on both sides so a symlinked cover file can't point the
  // served path outside the audiobooks root.
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = fs.realpathSync(getAudiobooksRoot());
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    return false;
  }
  return isUnder(realPath, realRoot);
}

/**
 * True when `filePath` may be served. Three ways in: a file the player's own
 * transcoder wrote, any path with an audio extension (the library genuinely
 * lives anywhere the user pointed it at), or an audiobook cover inside the
 * audiobooks root.
 */
export function isServableMediaPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  if (isUnder(resolved, getPlayerTempDir())) return true;
  if (isAudioFilePath(resolved)) return true;
  return isAudiobookCoverPath(resolved);
}
