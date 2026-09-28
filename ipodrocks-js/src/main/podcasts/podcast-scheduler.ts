import type Database from "better-sqlite3";
import { refreshAll } from "./podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "./podcast-device-sync";
import {
  getPodcastIndexConfig,
  getAutoPodcastSettings,
  isValidPodcastInterval,
  PODCAST_INTERVAL_DEFAULT_MINUTES,
} from "../utils/prefs";
import { isDeviceOnline, deviceRowToOnlineInput } from "../devices/device-online";
import { refreshUsbSnapshot } from "../devices/usb-devices";

interface DeviceRow {
  id: number;
  transport: string | null;
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
        "SELECT id, transport, mount_path, dev_mode, usb_vendor_id, usb_product_id, usb_serial FROM devices WHERE id = ?"
      )
      .get(deviceId) as DeviceRow | undefined) ?? null
  );
}

/**
 * At most one refresh-and-sync is ever in flight.
 *
 * Four things start one — boot, the interval tick, a device connecting, and
 * a scheduler restart from `podcast:setSettings` — and none of them used to
 * look whether one was already running. With a short cadence (or a download
 * that never finishes) the runs piled up without bound, each opening a request
 * per subscribed feed. A trigger that arrives mid-run now asks for *one* more
 * run after this one instead of starting its own: nothing requested is lost
 * (a device that connected mid-run still gets synced), and however many
 * triggers arrive, the queue is never deeper than one.
 */
let inFlightRun: Promise<void> | null = null;
let rerunRequested = false;

export function runRefreshAndSync(db: Database.Database): Promise<void> {
  if (inFlightRun) {
    rerunRequested = true;
    return inFlightRun;
  }
  const run = (async () => {
    try {
      do {
        rerunRequested = false;
        await runRefreshAndSyncOnce(db);
      } while (rerunRequested);
    } finally {
      inFlightRun = null;
    }
  })();
  inFlightRun = run;
  return run;
}

/** Test seam: is a scheduler run currently in flight? */
export function isPodcastRunInFlight(): boolean {
  return inFlightRun !== null;
}

async function runRefreshAndSyncOnce(db: Database.Database): Promise<void> {
  const config = getPodcastIndexConfig();
  // Each stage is isolated from the next: a refresh that fails must not cost
  // every device its sync, and one device that throws must not cost the rest.
  try {
    await refreshAll(db, config?.apiKey ?? "", config?.apiSecret ?? "");
  } catch (err) {
    console.error("[podcasts] refresh failed; syncing devices anyway:", err);
  }

  await refreshUsbSnapshot();
  for (const deviceId of getAutoPodcastDeviceIds(db)) {
    const info = getDeviceInfo(db, deviceId);
    const mountPath = info?.mount_path ?? null;
    const online = info ? isDeviceOnline(deviceRowToOnlineInput(info)) : false;
    if (!mountPath || !online) continue;
    try {
      await syncPodcastsToDevice(db, deviceId);
    } catch (err) {
      console.error(`[podcasts] auto-sync to device ${deviceId} failed:`, err);
    }
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
    // `getAutoPodcastSettings()` already clamps a stored value to 5..1440, but
    // this is the line that hands it to `setInterval`, where NaN or anything
    // past 2^31-1 ms silently becomes 1 ms. So it is checked again here, where
    // the consequence is, rather than trusted from a file on disk.
    const { refreshIntervalMinutes } = getAutoPodcastSettings();
    const minutes = isValidPodcastInterval(refreshIntervalMinutes)
      ? refreshIntervalMinutes
      : PODCAST_INTERVAL_DEFAULT_MINUTES;
    const intervalMs = minutes * 60 * 1000;

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
