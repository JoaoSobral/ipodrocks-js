import * as fs from "fs";
import * as path from "path";
import { parseFile } from "music-metadata";

const COVER_BASENAMES = ["cover.jpg", "cover.jpeg", "cover.png"];

function pickExtension(mime: string): "jpg" | "png" | null {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  return null;
}

export function showFolderHasCover(showDir: string): boolean {
  for (const name of COVER_BASENAMES) {
    if (fs.existsSync(path.join(showDir, name))) return true;
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
 */
export async function ensureShowCoverArt(
  sourceAudioPath: string,
  showDir: string
): Promise<{ written: string } | null> {
  if (showFolderHasCover(showDir)) return null;

  let picture: { data: Uint8Array; format: string } | undefined;
  try {
    const metadata = await parseFile(sourceAudioPath, { duration: false });
    picture = metadata.common.picture?.[0];
  } catch (err) {
    console.warn(`[podcasts] cover extract: read failed for ${sourceAudioPath}:`, err);
    return null;
  }
  if (!picture) return null;

  const ext = pickExtension(picture.format);
  if (!ext) return null;

  try {
    fs.mkdirSync(showDir, { recursive: true });
  } catch (err) {
    console.warn(`[podcasts] cover extract: mkdir failed for ${showDir}:`, err);
    return null;
  }

  const dest = path.join(showDir, `cover.${ext}`);
  const tmp = dest + ".tmp";
  try {
    fs.writeFileSync(tmp, picture.data);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.warn(`[podcasts] cover extract: write failed for ${dest}:`, err);
    return null;
  }
  return { written: dest };
}
