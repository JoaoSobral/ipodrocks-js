/**
 * Drive {@link repairMpcTags} over a directory tree.
 *
 * One walker serves both scopes the repair covers — a shadow library folder and
 * a device's content folders — so the two can never disagree about which files
 * are considered. It follows `ShadowLibraryManager.pruneOrphanedFiles()`: every
 * filesystem call is awaited and the loop yields, because this runs from an
 * ipcMain handler across a whole library and a synchronous walk froze the
 * window (including the spinner meant to show it was working).
 */

import fsp from "fs/promises";
import path from "path";
import type { Dirent } from "fs";

import { isMpcFile } from "../../utils/audio-extensions";
import { needsApeRepair, repairMpcTags } from "./repair";

/** Yield back to the event loop this often, in files examined. */
const YIELD_EVERY = 200;

export interface RepairScanResult {
  /** Musepack files examined. */
  scanned: number;
  /** Files whose tag block was rewritten. */
  repaired: number;
  /** Files that needed a repair but could not be written. */
  failed: number;
}

export interface RepairScanOptions {
  cancelSignal?: AbortSignal;
  onProgress?: (progress: RepairScanResult & { currentFile: string }) => void;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Repair every `.mpc` file under `root`. A missing or unreadable root is not an
 * error — it simply contributes nothing, so a disconnected device or a shadow
 * folder on an unmounted drive is skipped rather than failing the whole run.
 */
export async function repairMpcTagsInTree(
  root: string,
  options: RepairScanOptions = {}
): Promise<RepairScanResult> {
  const { cancelSignal, onProgress } = options;
  const result: RepairScanResult = { scanned: 0, repaired: 0, failed: 0 };

  const walk = async (dir: string): Promise<void> => {
    if (cancelSignal?.aborted) return;

    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: leave it entirely alone
    }

    for (const entry of dirents) {
      if (cancelSignal?.aborted) return;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // Symlinks report false here, so the walk never follows one out of the
      // tree and never rewrites a file outside it.
      if (!entry.isFile()) continue;
      if (!isMpcFile(entry.name)) continue;

      result.scanned++;
      if (await needsApeRepair(full)) {
        const outcome = await repairMpcTags(full);
        if (outcome === "repaired") result.repaired++;
        else if (outcome === "failed") result.failed++;
      }
      onProgress?.({ ...result, currentFile: full });

      if (result.scanned % YIELD_EVERY === 0) await yieldToEventLoop();
    }
  };

  await walk(root);
  return result;
}
