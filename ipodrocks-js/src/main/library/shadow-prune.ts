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
 * The only non-audio file a shadow build ever writes.
 *
 * `copyArtworkToShadowLibrary` generates exactly one per album folder
 * (`path.join(shadowRoot, albumRel, "cover.jpg")` in sync-core). Keeping this
 * list exact is what lets the prune stay safe — see {@link isPrunableName}.
 */
const SHADOW_ARTWORK_NAMES = new Set(["cover.jpg"]);

/**
 * Could the shadow builder have written a file with this name?
 *
 * The prune only ever deletes files iPodRocks put in the tree itself: a
 * transcode, or the `cover.jpg` generated beside it. Everything else is
 * somebody else's data and is left alone no matter what directory it sits in.
 *
 * This is the guard against the worst case for a tool that deletes files — a
 * shadow library pointed at a folder that also holds unrelated data (a
 * Documents folder, the root of a shared external drive). Judging such a file
 * on whether its *directory* still has live audio, as an earlier version did,
 * would have deleted every one of them.
 */
function isPrunableName(filePath: string): boolean {
  const name = path.basename(filePath);
  // A macOS AppleDouble sidecar is prunable only when the file it shadows is —
  // "._Thesis.docx" is the user's, "._01 - Song.mp3" is ours to clean up.
  if (isMacosMetadataFile(name)) return isPrunableName(name.slice(2));
  return isAudioFile(name) || SHADOW_ARTWORK_NAMES.has(name.toLowerCase());
}

/**
 * Decide which files in a shadow tree are orphans.
 *
 * Rules, in order of how much they matter:
 *
 *  1. A file the shadow builder could not have written is **never** an orphan,
 *     whatever else is true of it. See {@link isPrunableName}.
 *  2. An **audio** file is an orphan when no `shadow_tracks` row claims it.
 *     That is the whole point of the prune.
 *  3. A generated **cover.jpg** is an orphan only when its directory holds no
 *     claimed audio file. Artwork has no `shadow_tracks` row of its own, so
 *     judging it on its own would delete the cover of every live album.
 *  4. A macOS AppleDouble sidecar (`._name`) that passed rule 1 is always
 *     removable — it carries no audio and the OS recreates it as needed.
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
    if (!isPrunableName(e.path)) continue;

    const name = path.basename(e.path);
    if (isMacosMetadataFile(name)) {
      orphans.push(e);
      continue;
    }

    if (isAudioFile(e.path)) {
      if (!knownShadowPaths.has(e.normalizedPath)) orphans.push(e);
      continue;
    }

    // Generated artwork: keep it if this directory still has live audio in it.
    if (!liveDirs.has(e.normalizedDir)) orphans.push(e);
  }

  return {
    orphans,
    bytes: orphans.reduce((sum, e) => sum + e.size, 0),
  };
}
