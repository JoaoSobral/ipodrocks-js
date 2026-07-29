/**
 * Read the first embedded picture from an audio file.
 *
 * Shared by the podcast cover-art sidecar step and the Rockbox artwork
 * generator. MPC (Musepack) is read with our own APEv2 reader because
 * music-metadata's parseFile throws on tagged SV8 MPC.
 */
import { parseFile } from "music-metadata";
import { isMpcFile } from "./audio-extensions";
import { readApeTags } from "../tagging/reader";

export interface EmbeddedPicture {
  data: Uint8Array;
  /** MIME type as reported by the tag reader, e.g. "image/jpeg". */
  format: string;
}

/**
 * Returns the embedded cover art, or null when there is none or the file
 * cannot be read. Never throws — callers treat missing art as non-fatal.
 */
export async function extractEmbeddedPicture(
  audioPath: string
): Promise<EmbeddedPicture | null> {
  try {
    if (isMpcFile(audioPath)) {
      const cover = readApeTags(audioPath).coverArt;
      return cover ? { data: cover.data, format: cover.mimeType } : null;
    }
    const metadata = await parseFile(audioPath, { duration: false });
    const picture = metadata.common.picture?.[0];
    return picture ? { data: picture.data, format: picture.format } : null;
  } catch (err) {
    console.warn(
      `[embedded-art] read failed for ${audioPath}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
