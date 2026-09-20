import * as fs from "fs";
import * as path from "path";
import { localFs, type DeviceFs } from "../devices/fs";
import { extractEmbeddedPicture } from "../utils/embedded-art";

const COVER_BASENAMES = ["cover.jpg", "cover.jpeg", "cover.png"];

function pickExtension(mime: string): "jpg" | "png" | null {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  return null;
}

/** Does a local folder already carry cover art? */
export function showFolderHasCover(showDir: string): boolean {
  for (const name of COVER_BASENAMES) {
    if (fs.existsSync(path.join(showDir, name))) return true;
  }
  return false;
}

/**
 * The same question asked of a device, which may be a folder in someone's
 * browser. Kept apart from {@link showFolderHasCover} so that one can stay
 * synchronous for callers that genuinely hold a local path.
 */
async function targetHasCover(target: DeviceFs, showDir: string): Promise<boolean> {
  for (const name of COVER_BASENAMES) {
    if (await target.exists(path.join(showDir, name))) return true;
  }
  return false;
}

/**
 * Extract the first embedded picture from `sourceAudioPath` and write it as
 * `cover.{jpg,png}` into `showDir`. Rockbox falls back to this sidecar when
 * its ID3 APIC reader can't decode the embedded artwork.
 *
 * Returns the written path, or null when there's already a cover, no
 * embedded picture, or the read/write failed (failure is logged, not thrown,
 * because the episode audio sync should not be blocked by missing artwork).
 *
 * `target` defaults to the local filesystem, which is what a caller holding a
 * real folder path wants; the podcast sync passes the device's own.
 */
export async function ensureShowCoverArt(
  sourceAudioPath: string,
  showDir: string,
  target: DeviceFs = localFs(showDir)
): Promise<{ written: string } | null> {
  if (await targetHasCover(target, showDir)) return null;

  const picture = await extractEmbeddedPicture(sourceAudioPath);
  if (!picture) return null;

  const ext = pickExtension(picture.format);
  if (!ext) return null;

  try {
    await target.mkdir(showDir, { recursive: true });
  } catch (err) {
    console.warn(`[podcasts] cover extract: mkdir failed for ${showDir}:`, err);
    return null;
  }

  const dest = path.join(showDir, `cover.${ext}`);
  const tmp = dest + ".tmp";
  try {
    await target.writeFile(tmp, picture.data);
    await target.rename(tmp, dest);
  } catch (err) {
    try { await target.unlink(tmp); } catch { /* ignore */ }
    console.warn(`[podcasts] cover extract: write failed for ${dest}:`, err);
    return null;
  }
  return { written: dest };
}
