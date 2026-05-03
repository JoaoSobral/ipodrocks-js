/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";

let canRunDbTests = false;
try {
  const probe = require("better-sqlite3");
  const d = new probe(":memory:");
  d.close();
  canRunDbTests = true;
} catch { /* better-sqlite3 compiled for Electron; skip */ }

vi.mock("../main/podcasts/podcast-refresh", () => ({
  refreshAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../main/podcasts/podcast-device-sync", () => ({
  syncPodcastsToDevice: vi.fn().mockResolvedValue({ synced: 0, errors: 0 }),
  getAutoPodcastDeviceIds: vi.fn().mockReturnValue([]),
}));

vi.mock("../main/utils/prefs", () => ({
  getPodcastIndexConfig: vi.fn(),
  getAutoPodcastSettings: vi.fn().mockReturnValue({ enabled: true, refreshIntervalMinutes: 15 }),
}));

vi.mock("../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

import { refreshAll } from "../main/podcasts/podcast-refresh";
import { syncPodcastsToDevice, getAutoPodcastDeviceIds } from "../main/podcasts/podcast-device-sync";
import { getPodcastIndexConfig } from "../main/utils/prefs";
import { startPodcastScheduler, stopPodcastScheduler } from "../main/podcasts/podcast-scheduler";

let db: import("better-sqlite3").Database | null;

function setupDb(): import("better-sqlite3").Database | null {
  if (!canRunDbTests) return null;
  const Database = require("better-sqlite3");
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  d.prepare("INSERT INTO device_transfer_modes (name) VALUES (?)").run("copy");
  return d;
}

beforeEach(() => {
  db = setupDb();
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  stopPodcastScheduler();
  if (db) db.close();
  vi.useRealTimers();
});

describe("podcast scheduler", () => {
  it.skipIf(!canRunDbTests)("runs a boot refresh when creds are configured", async () => {
    vi.mocked(getPodcastIndexConfig).mockReturnValue({ apiKey: "k", apiSecret: "s" });
    vi.mocked(getAutoPodcastDeviceIds).mockReturnValue([]);

    startPodcastScheduler(db);
    await vi.runAllTimersAsync();

    expect(refreshAll).toHaveBeenCalledOnce();
  });

  it.skipIf(!canRunDbTests)("skips boot refresh when creds are absent", async () => {
    vi.mocked(getPodcastIndexConfig).mockReturnValue(null);

    startPodcastScheduler(db);
    await vi.runAllTimersAsync();

    expect(refreshAll).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("skips sync when no auto-podcast devices exist", async () => {
    vi.mocked(getPodcastIndexConfig).mockReturnValue({ apiKey: "k", apiSecret: "s" });
    vi.mocked(getAutoPodcastDeviceIds).mockReturnValue([]);

    startPodcastScheduler(db);
    await vi.runAllTimersAsync();

    expect(syncPodcastsToDevice).not.toHaveBeenCalled();
  });

  it.skipIf(!canRunDbTests)("syncs to a device when it is auto-podcast enabled and online", async () => {
    vi.mocked(getPodcastIndexConfig).mockReturnValue({ apiKey: "k", apiSecret: "s" });

    const modeRow = db.prepare("SELECT id FROM device_transfer_modes LIMIT 1").get() as { id: number };
    const stmt = db.prepare(
      "INSERT INTO devices (name, mount_path, music_folder, podcast_folder, " +
      "audiobook_folder, playlist_folder, default_transfer_mode_id, auto_podcasts_enabled) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const r = stmt.run("iPod", "/", "Music", "Podcasts", "Audiobooks", "Playlists", modeRow.id, 1);
    const deviceId = Number(r.lastInsertRowid);

    vi.mocked(getAutoPodcastDeviceIds).mockReturnValue([deviceId]);

    startPodcastScheduler(db);
    await vi.runAllTimersAsync();

    expect(syncPodcastsToDevice).toHaveBeenCalledWith(db, deviceId);
  });
});
