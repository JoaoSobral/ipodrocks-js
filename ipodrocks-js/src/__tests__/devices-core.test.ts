/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";
import { DevicesCore } from "../main/devices/devices-core";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node */
}

describe("DevicesCore.deleteDevice", () => {
  let db: import("better-sqlite3").Database;
  let core: DevicesCore;

  function setupDb() {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    // Seed device; device_transfer_modes seed gives id=1 for 'copy'
    db.prepare(
      `INSERT INTO devices (id, name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder, default_transfer_mode_id)
       VALUES (1, 'Test iPod', '/mnt/ipod', 'Music', 'Podcasts', 'Audiobooks', 'Playlists', 1)`
    ).run();
    core = new DevicesCore(db);
  }

  beforeEach(() => { if (canRunDbTests) setupDb(); });
  afterEach(() => { if (canRunDbTests && db) db.close(); });

  it.skipIf(!canRunDbTests)("deletes a device with no dependent rows", () => {
    expect(core.deleteDevice(1)).toBe(true);
    expect(db.prepare("SELECT id FROM devices WHERE id = 1").get()).toBeUndefined();
  });

  it.skipIf(!canRunDbTests)("throws when device does not exist", () => {
    expect(() => core.deleteDevice(999)).toThrow("Device with ID 999 not found");
  });

  it.skipIf(!canRunDbTests)("deletes device_synced_tracks rows for the device", () => {
    db.prepare("INSERT INTO device_synced_tracks (device_id, library_path) VALUES (1, '/lib/a.mp3')").run();
    db.prepare("INSERT INTO device_synced_tracks (device_id, library_path) VALUES (1, '/lib/b.mp3')").run();
    core.deleteDevice(1);
    expect(db.prepare("SELECT * FROM device_synced_tracks WHERE device_id = 1").all()).toHaveLength(0);
  });

  it.skipIf(!canRunDbTests)("deletes sync_configurations and their sync_rules for the device", () => {
    db.prepare(
      "INSERT INTO sync_configurations (id, device_id, config_name, sync_type) VALUES (10, 1, 'Main', 'full')"
    ).run();
    db.prepare("INSERT INTO sync_rules (sync_config_id, rule_type) VALUES (10, 'all')").run();
    core.deleteDevice(1);
    expect(db.prepare("SELECT * FROM sync_configurations WHERE device_id = 1").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM sync_rules WHERE sync_config_id = 10").all()).toHaveLength(0);
  });

  it.skipIf(!canRunDbTests)("NULLs genius_playlist_configs.device_id for the device", () => {
    db.prepare(
      "INSERT INTO playlists (id, name, playlist_type_id) VALUES (1, 'Test', (SELECT id FROM playlist_types WHERE name = 'genius'))"
    ).run();
    db.prepare("INSERT INTO genius_playlist_configs (playlist_id, genius_type, device_id) VALUES (1, 'similar', 1)").run();
    core.deleteDevice(1);
    const row = db.prepare("SELECT device_id FROM genius_playlist_configs WHERE playlist_id = 1").get() as { device_id: number | null };
    expect(row?.device_id).toBeNull();
  });

  it.skipIf(!canRunDbTests)("cascades device_track_ratings on delete (ON DELETE CASCADE)", () => {
    db.prepare("INSERT INTO tracks (id, path, filename, content_type) VALUES (1, '/lib/a.mp3', 'a.mp3', 'music')").run();
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating) VALUES (1, 1, 8)").run();
    core.deleteDevice(1);
    expect(db.prepare("SELECT * FROM device_track_ratings WHERE device_id = 1").all()).toHaveLength(0);
  });

  it.skipIf(!canRunDbTests)("removes app_settings default_device_id when it points to the deleted device", () => {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_device_id', '1')").run();
    core.deleteDevice(1);
    expect(db.prepare("SELECT value FROM app_settings WHERE key = 'default_device_id'").get()).toBeUndefined();
  });

  it.skipIf(!canRunDbTests)("preserves app_settings default_device_id when it points to a different device", () => {
    db.prepare(
      `INSERT INTO devices (id, name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder, default_transfer_mode_id)
       VALUES (2, 'Other iPod', '/mnt/other', 'Music', 'Podcasts', 'Audiobooks', 'Playlists', 1)`
    ).run();
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_device_id', '2')").run();
    core.deleteDevice(1);
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'default_device_id'").get() as { value: string } | undefined;
    expect(row?.value).toBe("2");
  });

  it.skipIf(!canRunDbTests)("NULLs playback_logs.device_db_id for the device", () => {
    db.prepare(
      `INSERT INTO playback_logs (device_id, device_db_id, timestamp_tick, elapsed_ms, total_ms, file_path)
       VALUES ('abc123', 1, 1000, 30000, 240000, '/lib/a.mp3')`
    ).run();
    core.deleteDevice(1);
    const row = db.prepare("SELECT device_db_id FROM playback_logs WHERE device_id = 'abc123'").get() as { device_db_id: number | null };
    expect(row?.device_db_id).toBeNull();
  });
});
