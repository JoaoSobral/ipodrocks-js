import type Database from "better-sqlite3";
import { refreshAll } from "./podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "./podcast-device-sync";
import { getPodcastIndexConfig, getAutoPodcastSettings } from "../utils/prefs";
import { isDeviceMountPathOnline } from "../devices/device-online";

interface DeviceRow {
  id: number;
  mount_path: string;
}

function getDeviceMountPath(db: Database.Database, deviceId: number): string | null {
  const row = db
    .prepare("SELECT id, mount_path FROM devices WHERE id = ?")
    .get(deviceId) as DeviceRow | undefined;
  return row?.mount_path ?? null;
}

async function runRefreshAndSync(db: Database.Database): Promise<void> {
  const config = getPodcastIndexConfig();
  if (!config) return;

  await refreshAll(db, config.apiKey, config.apiSecret);

  for (const deviceId of getAutoPodcastDeviceIds(db)) {
    const mountPath = getDeviceMountPath(db, deviceId);
    if (!mountPath || !isDeviceMountPathOnline(mountPath)) continue;
    await syncPodcastsToDevice(db, deviceId);
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let pollerTimer: ReturnType<typeof setInterval> | null = null;
let lastOnlineDeviceIds = new Set<number>();

export function startPodcastScheduler(db: Database.Database): void {
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
        const mountPath = getDeviceMountPath(db, deviceId);
        if (mountPath === null) continue;

        const online = isDeviceMountPathOnline(mountPath);
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
