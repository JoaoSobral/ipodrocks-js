import type Database from "better-sqlite3";
import { refreshAll } from "./podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "./podcast-device-sync";
import { getPodcastIndexConfig, getAutoPodcastSettings } from "../utils/prefs";
import { isDeviceMountPathOnline } from "../devices/device-online";

interface DeviceRow {
  id: number;
  mount_path: string;
  dev_mode: number;
}

function getDeviceInfo(db: Database.Database, deviceId: number): DeviceRow | null {
  return (
    (db
      .prepare("SELECT id, mount_path, dev_mode FROM devices WHERE id = ?")
      .get(deviceId) as DeviceRow | undefined) ?? null
  );
}

async function runRefreshAndSync(db: Database.Database): Promise<void> {
  console.log("[autopod-debug] runRefreshAndSync start");
  const config = getPodcastIndexConfig();
  console.log(`[autopod-debug] podcastIndexConfig present=${!!config}`);
  if (!config) return;

  await refreshAll(db, config.apiKey, config.apiSecret);

  const autoPodDeviceIds = getAutoPodcastDeviceIds(db);
  console.log(`[autopod-debug] auto-podcast device IDs:`, autoPodDeviceIds);
  for (const deviceId of autoPodDeviceIds) {
    const info = getDeviceInfo(db, deviceId);
    const mountPath = info?.mount_path ?? null;
    const devMode = !!(info?.dev_mode);
    const online = mountPath ? (devMode || isDeviceMountPathOnline(mountPath)) : false;
    console.log(`[autopod-debug] deviceId=${deviceId} mountPath="${mountPath}" devMode=${devMode} online=${online}`);
    if (!mountPath || !online) continue;
    await syncPodcastsToDevice(db, deviceId);
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let pollerTimer: ReturnType<typeof setInterval> | null = null;
let lastOnlineDeviceIds = new Set<number>();

export function startPodcastScheduler(db: Database.Database): void {
  console.log("[autopod-debug] startPodcastScheduler called");
  // Boot refresh — runRefreshAndSync no-ops when creds are missing.
  runRefreshAndSync(db).catch((err) =>
    console.error("[podcasts] boot refresh failed:", err)
  );

  // Periodic refresh cron — interval is read once on start; setting changes
  // restart the scheduler (see podcast:setSettings handler).
  if (!refreshTimer) {
    const { refreshIntervalMinutes } = getAutoPodcastSettings();
    const intervalMs = Math.max(5, refreshIntervalMinutes) * 60 * 1000;

    refreshTimer = setInterval(() => {
      if (!getAutoPodcastSettings().enabled) return;
      runRefreshAndSync(db).catch((err) =>
        console.error("[podcasts] scheduled refresh failed:", err)
      );
    }, intervalMs);
    refreshTimer.unref?.();
  }

  // 1-minute device connection poller — fills gaps when a device reconnects.
  if (!pollerTimer) {
    pollerTimer = setInterval(() => {
      if (!getPodcastIndexConfig()) return;

      for (const deviceId of getAutoPodcastDeviceIds(db)) {
        const info = getDeviceInfo(db, deviceId);
        const mountPath = info?.mount_path ?? null;
        if (mountPath === null) continue;

        const devMode = !!(info?.dev_mode);
        const online = devMode || isDeviceMountPathOnline(mountPath);
        const wasOnline = lastOnlineDeviceIds.has(deviceId);

        if (online) lastOnlineDeviceIds.add(deviceId);
        else lastOnlineDeviceIds.delete(deviceId);

        // Newly connected: fill gaps. One trigger per cycle is enough.
        if (online && !wasOnline) {
          runRefreshAndSync(db).catch((err) =>
            console.error("[podcasts] device-connect refresh failed:", err)
          );
          break;
        }
      }
    }, 60 * 1000);
    pollerTimer.unref?.();
  }
}

export function stopPodcastScheduler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}
