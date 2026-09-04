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

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type Database from "better-sqlite3";

import type { Device } from "../devices/device";
import type { ProgressCallback } from "./sync-core";
import type { ContentType } from "../../shared/types";

/** The folders "Delete all" clears. Playlists are rewritten every sync anyway. */
export const RESET_CONTENT_TYPES: ContentType[] = ["music", "podcast", "audiobook"];

export interface DeviceResetResult {
  /** Absolute paths that were emptied and recreated. */
  reset: string[];
  /** Paths refused by the safety guard, with the reason. */
  refused: Array<{ path: string; reason: string }>;
}

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

  for (const refusal of plan.refused) {
    progressCallback?.({
      event: "log",
      message: `Delete all: skipped ${refusal.path || "(no mount)"} — ${refusal.reason}.`,
    });
  }

  const done: string[] = [];
  for (const dir of plan.reset) {
    if (cancelSignal?.aborted) break;
    try {
      if (fs.existsSync(dir)) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
      await fsp.mkdir(dir, { recursive: true });
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

  return { reset: done, refused: plan.refused };
}
