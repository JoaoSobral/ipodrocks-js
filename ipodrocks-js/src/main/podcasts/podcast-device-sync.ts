import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { listSubscriptions } from "./podcast-subscriptions";
import { getReadyTargetEpisodes } from "./podcast-refresh";
import { sanitizeDevicePathComponent } from "../sync/sync-core";
import { copyFileToDevice } from "../sync/sync-executor";

interface DeviceRow {
  id: number;
  mount_path: string;
  podcast_folder: string;
  auto_podcasts_enabled: number;
}

/**
 * Sync all ready podcast episodes for a device.
 * Only writes into the device's Podcasts folder; never touches library tables.
 */
export async function syncPodcastsToDevice(
  db: Database.Database,
  deviceId: number
): Promise<{ synced: number; errors: number }> {
  const device = db
    .prepare(
      "SELECT id, mount_path, podcast_folder, auto_podcasts_enabled FROM devices WHERE id = ?"
    )
    .get(deviceId) as DeviceRow | undefined;

  if (!device || !device.auto_podcasts_enabled || !device.mount_path) {
    return { synced: 0, errors: 0 };
  }

  if (!fs.existsSync(device.mount_path)) {
    return { synced: 0, errors: 0 };
  }

  const podcastRoot = path.join(device.mount_path, device.podcast_folder ?? "Podcasts");
  const subs = listSubscriptions(db);
  let synced = 0;
  let errors = 0;

  for (const sub of subs) {
    const episodes = getReadyTargetEpisodes(db, sub.id);

    for (const ep of episodes) {
      const alreadySynced = db
        .prepare(
          "SELECT 1 FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?"
        )
        .get(deviceId, ep.id);
      if (alreadySynced) continue;

      const showDir = sanitizeDevicePathComponent(sub.title);
      const ext = path.extname(ep.localPath) || ".mp3";
      const filename = `${ep.id}${ext}`;
      const destRelative = path.join(device.podcast_folder ?? "Podcasts", showDir, filename);
      const destAbsolute = path.join(device.mount_path, destRelative);

      try {
        await copyFileToDevice(ep.localPath, destAbsolute);
        db.prepare(
          `INSERT OR IGNORE INTO device_podcast_synced (device_id, episode_id, device_relative_path)
           VALUES (?, ?, ?)`
        ).run(deviceId, ep.id, destRelative);
        synced++;
      } catch (err) {
        console.error(`[podcasts] sync failed ep ${ep.id} → device ${deviceId}:`, err);
        errors++;
      }
    }
  }

  return { synced, errors };
}

/** Returns device IDs of online devices that have auto_podcasts_enabled = 1. */
export function getAutoPodcastDeviceIds(db: Database.Database): number[] {
  const rows = db
    .prepare(
      "SELECT id FROM devices WHERE auto_podcasts_enabled = 1"
    )
    .all() as { id: number }[];
  return rows.map((r) => r.id);
}
