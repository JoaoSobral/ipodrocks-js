/**
 * Classification for the shadow-library orphan prune.
 *
 * A shadow library is meant to be a faithful copy of the main library in a
 * different codec — nothing it holds should outlive its source. In practice
 * files did outlive it: until the `removedShadowPaths` fix, renaming or
 * deleting an album left its transcodes behind with no `shadow_tracks` row
 * pointing at them, so the shadow tree accumulated copies of albums the library
 * no longer has. The prune is the one-shot cleanup for that backlog.
 *
 * This module is deliberately pure — no database, no filesystem. Deciding what
 * to delete is the dangerous part, so it is testable in complete isolation.
 * `shadow-library.ts` walks the tree and performs the deletions.
 */
import * as path from "path";
import { AUDIO_EXTENSIONS, isMacosMetadataFile } from "../utils/audio-extensions";

/** One file found while walking a shadow-library tree. */
export interface ShadowFileEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path in the form used to compare against `shadow_tracks.shadow_path`. */
  normalizedPath: string;
  /** Directory the file sits in, normalized the same way. */
  normalizedDir: string;
  size: number;
}

export interface PruneDecision {
  /** Files safe to delete. */
  orphans: ShadowFileEntry[];
  /** Total bytes the orphans occupy. */
  bytes: number;
}

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Decide which files in a shadow tree are orphans.
 *
 * Rules, in order of how much they matter:
 *
 *  1. An **audio** file is an orphan when no `shadow_tracks` row claims it.
 *     That is the whole point of the prune.
 *  2. A **non-audio** file (`cover.jpg` and friends, written by
 *     `copyArtworkToShadowLibrary`) is an orphan only when its directory holds
 *     no claimed audio file. Artwork has no `shadow_tracks` row of its own, so
 *     judging it on its own would delete the cover of every live album.
 *  3. macOS AppleDouble sidecars (`._name`) are always removable — they carry
 *     no audio and are recreated by the OS as needed.
 *
 * Anything the caller could not stat is simply absent from `entries` and is
 * therefore never deleted.
 */
export function decidePrune(
  entries: ShadowFileEntry[],
  knownShadowPaths: Set<string>
): PruneDecision {
  // Directories that still hold at least one file the library knows about.
  // Their artwork must survive.
  const liveDirs = new Set<string>();
  for (const e of entries) {
    if (isAudioFile(e.path) && knownShadowPaths.has(e.normalizedPath)) {
      liveDirs.add(e.normalizedDir);
    }
  }

  const orphans: ShadowFileEntry[] = [];
  for (const e of entries) {
    const name = path.basename(e.path);

    if (isMacosMetadataFile(name)) {
      orphans.push(e);
      continue;
    }

    if (isAudioFile(e.path)) {
      if (!knownShadowPaths.has(e.normalizedPath)) orphans.push(e);
      continue;
    }

    // Non-audio: keep it if this directory still has live audio in it.
    if (!liveDirs.has(e.normalizedDir)) orphans.push(e);
  }

  return {
    orphans,
    bytes: orphans.reduce((sum, e) => sum + e.size, 0),
  };
}
