import type Database from "better-sqlite3";
import { refreshAll } from "./podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "./podcast-device-sync";
import { getPodcastIndexConfig, getAutoPodcastSettings } from "../utils/prefs";
import { isDeviceOnline, deviceRowToOnlineInput } from "../devices/device-online";
import { refreshUsbSnapshot } from "../devices/usb-devices";

interface DeviceRow {
  id: number;
  mount_path: string;
  dev_mode: number;
  usb_vendor_id: string | null;
  usb_product_id: string | null;
  usb_serial: string | null;
}

function getDeviceInfo(db: Database.Database, deviceId: number): DeviceRow | null {
  return (
    (db
      .prepare(
        "SELECT id, mount_path, dev_mode, usb_vendor_id, usb_product_id, usb_serial FROM devices WHERE id = ?"
      )
      .get(deviceId) as DeviceRow | undefined) ?? null
  );
}

async function runRefreshAndSync(db: Database.Database): Promise<void> {
  const config = getPodcastIndexConfig();
  await refreshAll(db, config?.apiKey ?? "", config?.apiSecret ?? "");

  await refreshUsbSnapshot();
  for (const deviceId of getAutoPodcastDeviceIds(db)) {
    const info = getDeviceInfo(db, deviceId);
    const mountPath = info?.mount_path ?? null;
    const online = info ? isDeviceOnline(deviceRowToOnlineInput(info)) : false;
    if (!mountPath || !online) continue;
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
      void pollDeviceConnections(db);
    }, 60_000);
    pollerTimer.unref?.();
  }
}

/** One connection sweep: refresh the USB snapshot, then resolve every device. */
async function pollDeviceConnections(db: Database.Database): Promise<void> {
  await refreshUsbSnapshot();
  for (const deviceId of getAutoPodcastDeviceIds(db)) {
    const info = getDeviceInfo(db, deviceId);
    if (!info?.mount_path) continue;

    const online = isDeviceOnline(deviceRowToOnlineInput(info));
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
