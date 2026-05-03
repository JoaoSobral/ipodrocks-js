import * as path from "path";
import type Database from "better-sqlite3";
import { listSubscriptions } from "./podcast-subscriptions";
import { getReadyTargetEpisodes } from "./podcast-refresh";
import { sanitizeDevicePathComponent } from "../sync/sync-core";
import { copyFileToDevice } from "../sync/sync-executor";
import type { SyncProgressPayload } from "../sync/sync-core";
import { isDeviceMountPathOnline } from "../devices/device-online";

type ProgressCallback = (event: SyncProgressPayload) => void;

interface DeviceRow {
  id: number;
  mount_path: string;
  podcast_folder: string;
  auto_podcasts_enabled: number;
}

interface EpisodeToSync {
  epId: number;
  localPath: string;
  destRelative: string;
  destAbsolute: string;
}

/**
 * Sync all ready podcast episodes for a device.
 * Only writes into the device's Podcasts folder; never touches library tables.
 */
export async function syncPodcastsToDevice(
  db: Database.Database,
  deviceId: number,
  progressCallback?: ProgressCallback
): Promise<{ synced: number; errors: number }> {
  const device = db
    .prepare(
      "SELECT id, mount_path, podcast_folder, auto_podcasts_enabled FROM devices WHERE id = ?"
    )
    .get(deviceId) as DeviceRow | undefined;

  if (!device || !device.auto_podcasts_enabled || !device.mount_path) {
    return { synced: 0, errors: 0 };
  }

  if (!isDeviceMountPathOnline(device.mount_path)) {
    return { synced: 0, errors: 0 };
  }

  const subs = listSubscriptions(db);

  if (subs.length === 0) {
    progressCallback?.({ event: "log", message: "Auto Podcasts: no subscriptions configured." });
    return { synced: 0, errors: 0 };
  }

  // Collect all episodes that need to be copied to this device
  const toSync: EpisodeToSync[] = [];
  for (const sub of subs) {
    const episodes = getReadyTargetEpisodes(db, sub.id);
    for (const ep of episodes) {
      const alreadySynced = db
        .prepare("SELECT 1 FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?")
        .get(deviceId, ep.id);
      if (alreadySynced) continue;

      const showDir = sanitizeDevicePathComponent(sub.title);
      const ext = path.extname(ep.localPath) || ".mp3";
      const filename = `${ep.id}${ext}`;
      const destRelative = path.join(device.podcast_folder ?? "Podcasts", showDir, filename);
      const destAbsolute = path.join(device.mount_path, destRelative);
      toSync.push({ epId: ep.id, localPath: ep.localPath, destRelative, destAbsolute });
    }
  }

  if (toSync.length === 0) {
    progressCallback?.({ event: "log", message: "Auto Podcasts: all episodes already synced to this device." });
    return { synced: 0, errors: 0 };
  }

  progressCallback?.({ event: "total_add", path: String(toSync.length) });
  progressCallback?.({ event: "log", message: `Auto Podcasts: syncing ${toSync.length} episode(s)...` });

  let synced = 0;
  let errors = 0;

  for (const ep of toSync) {
    try {
      await copyFileToDevice(ep.localPath, ep.destAbsolute);
      db.prepare(
        `INSERT OR IGNORE INTO device_podcast_synced (device_id, episode_id, device_relative_path)
         VALUES (?, ?, ?)`
      ).run(deviceId, ep.epId, ep.destRelative);
      synced++;
      progressCallback?.({
        event: "copy",
        path: path.basename(ep.destAbsolute),
        destination: ep.destAbsolute,
        status: "copied",
        contentType: "podcast",
      });
    } catch (err) {
      console.error(`[podcasts] sync failed ep ${ep.epId} → device ${deviceId}:`, err);
      errors++;
      progressCallback?.({
        event: "copy",
        path: ep.localPath,
        destination: ep.destAbsolute,
        status: "error",
        contentType: "podcast",
      });
    }
  }

  return { synced, errors };
}

/**
 * Returns IDs of all devices with `auto_podcasts_enabled = 1`.
 * Callers are responsible for checking `isDeviceMountPathOnline` before
 * attempting to sync — this function does not filter by online status.
 */
export function getAutoPodcastDeviceIds(db: Database.Database): number[] {
  const rows = db
    .prepare("SELECT id FROM devices WHERE auto_podcasts_enabled = 1")
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}
