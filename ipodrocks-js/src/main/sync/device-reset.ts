/**
 * "Delete all" — erase the device's content folders so a sync rebuilds them.
 *
 * This is the reset half of the Orphan & Reset Policy. Unlike "Remove orphans",
 * which deletes only what the sync selection does not account for, this throws
 * the content folders away wholesale and lets the copy phase put them back.
 *
 * **It must run before the device is enumerated.** `runSync` compares the
 * library against the file listing read from the device, so a wipe performed
 * after that listing would leave the sync believing every track is still there
 * and copying nothing back — an empty device and a "0 synced" report.
 */

import path from "path";
import type Database from "better-sqlite3";

import type { Device } from "../devices/device";
import type { DeviceFs } from "../devices/fs";
import type { ProgressCallback } from "./sync-core";
import type { ContentType } from "../../shared/types";

/** The folders "Delete all" clears. Playlists are rewritten every sync anyway. */
export const RESET_CONTENT_TYPES: ContentType[] = ["music", "podcast", "audiobook"];

export interface DeviceResetResult {
  /** Absolute paths that were emptied and recreated. */
  reset: string[];
  /** Paths refused by the safety guard, with the reason. */
  refused: Array<{ path: string; reason: string }>;
  /**
   * Deletion still running after the folders were already swapped out for
   * empty ones — see {@link resetDeviceContent}. The sync awaits it before it
   * reports done, so a device is never handed back with a trash folder on it.
   * Never rejects.
   */
  background?: Promise<void>;
}

/**
 * Where a local reset parks a content folder while it is deleted. A dot
 * folder at the mount root: the same volume, so the rename is instant, and
 * outside every content folder the sync is about to write into. A crash
 * mid-delete leaves one behind; the next reset sweeps it.
 */
export const RESET_TRASH_PREFIX = ".ipodrocks-trash-";

/** Files removed per `rmMany` when clearing a folder over the network. */
const REMOTE_CLEAR_CHUNK = 500;

export interface DeviceResetOptions {
  progressCallback?: ProgressCallback;
  cancelSignal?: AbortSignal;
}

/**
 * Which content folders it is safe to erase.
 *
 * `Device.musicFolder` and friends fall back with `?? "Music"`, which does not
 * catch an *empty string* stored in the profile — `path.join(mount, "")`
 * resolves to the mount root, and erasing that would take the whole device with
 * it, Rockbox included. So a path is only ever accepted when it sits strictly
 * inside the mount. Duplicates are collapsed too, in case a profile points two
 * content types at one folder.
 */
export function resolveResettableFolders(device: Device): DeviceResetResult {
  const result: DeviceResetResult = { reset: [], refused: [] };

  const mount = device.mountPath ? path.resolve(device.mountPath) : "";
  if (!mount) {
    result.refused.push({ path: "", reason: "device has no mount path" });
    return result;
  }

  const seen = new Set<string>();
  for (const contentType of RESET_CONTENT_TYPES) {
    const raw = device.getContentPath(contentType);
    if (!raw) continue;
    const resolved = path.resolve(raw);

    if (resolved === mount || !resolved.startsWith(mount + path.sep)) {
      result.refused.push({
        path: resolved,
        reason: `${contentType} folder resolves to the device root`,
      });
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.reset.push(resolved);
  }

  return result;
}

/**
 * Erase and recreate the device's content folders, and drop the bookkeeping
 * that would otherwise make the sync think the files are still there.
 */
export async function resetDeviceContent(
  device: Device,
  db: Database.Database,
  deviceId: number,
  options: DeviceResetOptions = {}
): Promise<DeviceResetResult> {
  const { progressCallback, cancelSignal } = options;
  const plan = resolveResettableFolders(device);
  const deviceFs = device.fs;

  for (const refusal of plan.refused) {
    progressCallback?.({
      event: "log",
      message: `Delete all: skipped ${refusal.path || "(no mount)"} — ${refusal.reason}.`,
    });
  }

  const done: string[] = [];
  const trash: string[] = [];
  const mount = device.mountPath ? path.resolve(device.mountPath) : "";
  for (const [index, dir] of plan.reset.entries()) {
    if (cancelSignal?.aborted) break;
    try {
      if (await deviceFs.exists(dir)) {
        if (deviceFs.capabilities.overNetwork) {
          await clearOverNetwork(deviceFs, dir, progressCallback, cancelSignal);
        } else {
          // Swap the folder out for an empty one and delete the old one while
          // the sync copies: on a USB player a recursive delete of a full
          // library is minutes the user otherwise spends watching nothing.
          const parked = path.join(mount, `${RESET_TRASH_PREFIX}${Date.now()}-${index}`);
          try {
            await deviceFs.rename(dir, parked);
            trash.push(parked);
          } catch {
            // A volume that will not rename a directory still gets cleared,
            // just in the foreground.
            await deviceFs.rm(dir, { recursive: true, force: true });
          }
        }
      }
      await deviceFs.mkdir(dir, { recursive: true });
      done.push(dir);
      progressCallback?.({
        event: "log",
        message: `Delete all: cleared ${path.basename(dir)}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      plan.refused.push({ path: dir, reason: msg });
      progressCallback?.({
        event: "log",
        message: `Delete all: could not clear ${dir} — ${msg}`,
      });
    }
  }

  // The copy phase decides what to send from these tables as much as from the
  // file listing, so they have to go with the files. Ratings and runtime stats
  // are keyed on the device rather than on files and are deliberately left
  // alone — see the rebuilt-database hazard in CLAUDE.md.
  if (done.length > 0) {
    for (const table of [
      "device_synced_tracks",
      "device_podcast_synced",
      "device_audiobook_synced",
    ]) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE device_id = ?`).run(deviceId);
      } catch (err) {
        console.error(`[sync] Delete all: clearing ${table} failed:`, err);
      }
    }
  }

  if (mount && !deviceFs.capabilities.overNetwork) {
    trash.push(...(await staleTrash(deviceFs, mount, trash)));
  }

  return {
    reset: done,
    refused: plan.refused,
    background: trash.length > 0 ? emptyTrash(deviceFs, trash) : undefined,
  };
}

/** Trash folders an earlier, interrupted reset left at the mount root. */
async function staleTrash(
  deviceFs: DeviceFs,
  mount: string,
  current: string[]
): Promise<string[]> {
  try {
    const entries = await deviceFs.readdir(mount);
    return entries
      .filter((e) => e.isDirectory && e.name.startsWith(RESET_TRASH_PREFIX))
      .map((e) => path.join(mount, e.name))
      .filter((p) => !current.includes(p));
  } catch {
    return [];
  }
}

async function emptyTrash(deviceFs: DeviceFs, dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await deviceFs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[sync] Delete all: could not remove ${dir}:`, err);
      }
    })
  );
}

/**
 * Empties a folder on a browser-held device in chunks rather than with one
 * recursive `removeEntry`.
 *
 * One call was a single RPC that had to finish inside the control-plane
 * timeout — two minutes to delete a whole library from a USB player through a
 * browser — with nothing to show while it ran. Files go first,
 * {@link REMOTE_CLEAR_CHUNK} per call with a progress line each, then the
 * emptied folders deepest first, then a final recursive remove for anything
 * the listing missed, which by then is close to nothing.
 */
async function clearOverNetwork(
  deviceFs: DeviceFs,
  dir: string,
  progressCallback: ProgressCallback | undefined,
  cancelSignal: AbortSignal | undefined
): Promise<void> {
  const entries = await deviceFs.listTree(dir);
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const name = path.basename(dir);

  for (let start = 0; start < files.length; start += REMOTE_CLEAR_CHUNK) {
    if (cancelSignal?.aborted) return;
    await deviceFs.rmMany(files.slice(start, start + REMOTE_CLEAR_CHUNK));
    const done = Math.min(files.length, start + REMOTE_CLEAR_CHUNK);
    progressCallback?.({
      event: "log",
      message: `Delete all: removed ${done}/${files.length} file(s) from ${name}.`,
    });
  }

  const dirsByDepth = new Map<number, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    const depth = entry.path.split(path.sep).length;
    const bucket = dirsByDepth.get(depth) ?? [];
    bucket.push(entry.path);
    dirsByDepth.set(depth, bucket);
  }
  for (const depth of [...dirsByDepth.keys()].sort((a, b) => b - a)) {
    if (cancelSignal?.aborted) return;
    await deviceFs.rmMany(dirsByDepth.get(depth)!);
  }

  await deviceFs.rm(dir, { recursive: true, force: true });
}
