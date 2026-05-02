import type Database from "better-sqlite3";
import { refreshAll } from "./podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "./podcast-device-sync";
import { getPodcastIndexConfig, getAutoPodcastSettings } from "../utils/prefs";

interface DeviceRow {
  id: number;
  mount_path: string;
}

function isDeviceOnline(mountPath: string): boolean {
  if (!mountPath) return false;
  try {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const resolved = path.resolve(mountPath);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return false;
    if (process.platform === "win32") return true;
    const parentStat = fs.statSync(path.dirname(resolved));
    return stat.dev !== parentStat.dev;
  } catch {
    return false;
  }
}

async function runRefreshAndSync(db: Database.Database): Promise<void> {
  const config = getPodcastIndexConfig();
  if (!config) return;

  await refreshAll(db, config.apiKey, config.apiSecret);

  const deviceIds = getAutoPodcastDeviceIds(db);
  for (const deviceId of deviceIds) {
    const device = db
      .prepare("SELECT id, mount_path FROM devices WHERE id = ?")
      .get(deviceId) as DeviceRow | undefined;
    if (!device) continue;
    if (!isDeviceOnline(device.mount_path)) continue;
    await syncPodcastsToDevice(db, deviceId);
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let pollerTimer: ReturnType<typeof setInterval> | null = null;
let lastOnlineDeviceIds = new Set<number>();

export function startPodcastScheduler(db: Database.Database): void {
  // Boot refresh — run once at startup
  const config = getPodcastIndexConfig();
  if (config) {
    runRefreshAndSync(db).catch((err) =>
      console.error("[podcasts] boot refresh failed:", err)
    );
  }

  // 15-minute refresh cron (interval may be overridden by settings)
  if (!refreshTimer) {
    const { refreshIntervalMinutes } = getAutoPodcastSettings();
    const intervalMs = Math.max(5, refreshIntervalMinutes) * 60 * 1000;

    refreshTimer = setInterval(() => {
      const settings = getAutoPodcastSettings();
      if (!settings.enabled) return;
      const cfg = getPodcastIndexConfig();
      if (!cfg) return;
      runRefreshAndSync(db).catch((err) =>
        console.error("[podcasts] scheduled refresh failed:", err)
      );
    }, intervalMs);
    refreshTimer.unref?.();
  }

  // 1-minute device connection poller
  if (!pollerTimer) {
    pollerTimer = setInterval(() => {
      const config = getPodcastIndexConfig();
      if (!config) return;

      const deviceIds = getAutoPodcastDeviceIds(db);
      for (const deviceId of deviceIds) {
        const device = db
          .prepare("SELECT id, mount_path FROM devices WHERE id = ?")
          .get(deviceId) as DeviceRow | undefined;
        if (!device) continue;

        const online = isDeviceOnline(device.mount_path);
        const wasOnline = lastOnlineDeviceIds.has(deviceId);

        if (online) {
          lastOnlineDeviceIds.add(deviceId);
        } else {
          lastOnlineDeviceIds.delete(deviceId);
        }

        // Newly connected: fill gaps
        if (online && !wasOnline) {
          runRefreshAndSync(db).catch((err) =>
            console.error("[podcasts] device-connect refresh failed:", err)
          );
          // Only need one trigger per cycle
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
