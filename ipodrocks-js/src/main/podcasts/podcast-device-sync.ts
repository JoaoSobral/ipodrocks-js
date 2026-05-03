import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { listSubscriptions } from "./podcast-subscriptions";
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
  dev_mode: number;
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
  console.log(`[autopod-debug] syncPodcastsToDevice called for deviceId=${deviceId}`);

  const device = db
    .prepare(
      "SELECT id, mount_path, podcast_folder, auto_podcasts_enabled, dev_mode FROM devices WHERE id = ?"
    )
    .get(deviceId) as DeviceRow | undefined;

  console.log(`[autopod-debug] device row:`, JSON.stringify(device));

  if (!device) {
    console.log(`[autopod-debug] SKIP: device not found in DB`);
    return { synced: 0, errors: 0 };
  }
  if (!device.auto_podcasts_enabled) {
    console.log(`[autopod-debug] SKIP: auto_podcasts_enabled=${device.auto_podcasts_enabled}`);
    return { synced: 0, errors: 0 };
  }
  if (!device.mount_path) {
    console.log(`[autopod-debug] SKIP: mount_path is empty/null`);
    return { synced: 0, errors: 0 };
  }

  const online = !!device.dev_mode || isDeviceMountPathOnline(device.mount_path);
  console.log(`[autopod-debug] mount_path="${device.mount_path}" dev_mode=${device.dev_mode} online=${online}`);
  if (!online) {
    console.log(`[autopod-debug] SKIP: device is not online`);
    return { synced: 0, errors: 0 };
  }

  const subs = listSubscriptions(db);
  console.log(`[autopod-debug] subscriptions count=${subs.length}`, subs.map((s) => ({ id: s.id, title: s.title })));

  if (subs.length === 0) {
    progressCallback?.({ event: "log", message: "Auto Podcasts: no subscriptions configured." });
    return { synced: 0, errors: 0 };
  }

  // Collect all episodes that need to be copied to this device.
  // Mirror everything that is locally ready — auto_count governs downloads, not the device mirror.
  const toSync: EpisodeToSync[] = [];
  for (const sub of subs) {
    const episodes = (db
      .prepare(
        `SELECT id, local_path FROM podcast_episodes
         WHERE subscription_id = ? AND download_state = 'ready' AND local_path IS NOT NULL
         ORDER BY published_at DESC`
      )
      .all(sub.id) as Array<{ id: number; local_path: string }>)
      .map((r) => ({ id: r.id, localPath: r.local_path }));
    console.log(`[autopod-debug] sub id=${sub.id} title="${sub.title}" ready episodes=${episodes.length}`, episodes.map((e) => ({ id: e.id, localPath: e.localPath })));
    for (const ep of episodes) {
      const syncedRow = db
        .prepare("SELECT device_relative_path FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?")
        .get(deviceId, ep.id) as { device_relative_path: string } | undefined;
      if (syncedRow) {
        const existsOnDevice = fs.existsSync(path.join(device.mount_path, syncedRow.device_relative_path));
        console.log(`[autopod-debug] episode id=${ep.id} alreadySynced=true existsOnDevice=${existsOnDevice} path="${syncedRow.device_relative_path}"`);
        if (existsOnDevice) continue;
        // Stale record — file was removed from device; remove stale record and re-copy
        db.prepare("DELETE FROM device_podcast_synced WHERE device_id = ? AND episode_id = ?").run(deviceId, ep.id);
      } else {
        console.log(`[autopod-debug] episode id=${ep.id} alreadySynced=false localPath="${ep.localPath}"`);
      }

      const showDir = sanitizeDevicePathComponent(sub.title);
      const ext = path.extname(ep.localPath) || ".mp3";
      const filename = `${ep.id}${ext}`;
      const destRelative = path.join(device.podcast_folder ?? "Podcasts", showDir, filename);
      const destAbsolute = path.join(device.mount_path, destRelative);
      console.log(`[autopod-debug] queuing episode id=${ep.id} → destAbsolute="${destAbsolute}"`);
      toSync.push({ epId: ep.id, localPath: ep.localPath, destRelative, destAbsolute });
    }
  }

  console.log(`[autopod-debug] toSync count=${toSync.length}`);
  if (toSync.length === 0) {
    progressCallback?.({ event: "log", message: "Auto Podcasts: all episodes already synced to this device." });
    return { synced: 0, errors: 0 };
  }

  progressCallback?.({ event: "total_add", path: String(toSync.length) });
  progressCallback?.({ event: "log", message: `Auto Podcasts: syncing ${toSync.length} episode(s)...` });

  let synced = 0;
  let errors = 0;

  for (const ep of toSync) {
    console.log(`[autopod-debug] copying ep ${ep.epId}: "${ep.localPath}" → "${ep.destAbsolute}"`);
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
