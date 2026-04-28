/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SCHEMA_SQL } from "../main/database/schema";
import {
  getDeviceSyncPreferences,
  saveDeviceSyncPreferences,
} from "../main/sync/device-sync-preferences";
import type { DeviceSyncPreferences } from "../shared/types";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node; skip DB tests */
}

describe("device-sync-preferences", () => {
  let db: import("better-sqlite3").Database | null;

  beforeEach(() => {
    if (canRunDbTests) {
      const Database = require("better-sqlite3");
      db = new Database(":memory:") as import("better-sqlite3").Database;
      db!.pragma("journal_mode = WAL");
      db!.pragma("foreign_keys = ON");
      db!.exec(SCHEMA_SQL);
      db!.prepare(
        "INSERT INTO devices (id, name, mount_path, default_transfer_mode_id) VALUES (1, 'iPod 1', '/mnt/ipod1', 1)"
      ).run();
      db!.prepare(
        "INSERT INTO devices (id, name, mount_path, default_transfer_mode_id) VALUES (2, 'iPod 2', '/mnt/ipod2', 1)"
      ).run();
    } else {
      db = null;
    }
  });

  afterEach(() => {
    if (db) db!.close();
    db = null;
  });

  it.skipIf(!canRunDbTests)(
    "returns null for an unseen device",
    () => {
      const result = getDeviceSyncPreferences(db!, 999);
      expect(result).toBeNull();
    }
  );

  it.skipIf(!canRunDbTests)(
    "round-trips all fields including CustomSelections arrays",
    () => {
      const prefs: DeviceSyncPreferences = {
        syncType: "custom",
        extraTrackPolicy: "remove",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: true,
        ignoreSpaceCheck: true,
        skipAlbumArtwork: true,
        selections: {
          albums: ["Abbey Road — The Beatles"],
          artists: ["The Beatles"],
          genres: ["Rock"],
          podcasts: ["My Podcast"],
          audiobooks: ["My Audiobook"],
          playlists: ["Favourites"],
        },
      };
      saveDeviceSyncPreferences(db!, 1, prefs);
      const loaded = getDeviceSyncPreferences(db!, 1);
      expect(loaded).not.toBeNull();
      expect(loaded!.syncType).toBe("custom");
      expect(loaded!.extraTrackPolicy).toBe("remove");
      expect(loaded!.includeMusic).toBe(true);
      expect(loaded!.includePodcasts).toBe(false);
      expect(loaded!.includeAudiobooks).toBe(false);
      expect(loaded!.includePlaylists).toBe(true);
      expect(loaded!.ignoreSpaceCheck).toBe(true);
      expect(loaded!.skipAlbumArtwork).toBe(true);
      expect(loaded!.selections.albums).toEqual(["Abbey Road — The Beatles"]);
      expect(loaded!.selections.artists).toEqual(["The Beatles"]);
      expect(loaded!.selections.genres).toEqual(["Rock"]);
      expect(loaded!.selections.podcasts).toEqual(["My Podcast"]);
      expect(loaded!.selections.audiobooks).toEqual(["My Audiobook"]);
      expect(loaded!.selections.playlists).toEqual(["Favourites"]);
    }
  );

  it.skipIf(!canRunDbTests)(
    "second save updates the row without duplicating it and bumps updated_at",
    () => {
      const prefs1: DeviceSyncPreferences = {
        syncType: "full",
        extraTrackPolicy: "keep",
        includeMusic: true,
        includePodcasts: true,
        includeAudiobooks: true,
        includePlaylists: true,
        ignoreSpaceCheck: false,
        skipAlbumArtwork: false,
        selections: { albums: [], artists: [], genres: [], podcasts: [], audiobooks: [], playlists: [] },
      };
      saveDeviceSyncPreferences(db!, 1, prefs1);

      const row1 = db!
        .prepare("SELECT updated_at FROM device_sync_preferences WHERE device_id = 1")
        .get() as { updated_at: string };

      const prefs2: DeviceSyncPreferences = { ...prefs1, syncType: "custom", extraTrackPolicy: "remove" };
      saveDeviceSyncPreferences(db!, 1, prefs2);

      const count = (
        db!
          .prepare("SELECT COUNT(*) as c FROM device_sync_preferences WHERE device_id = 1")
          .get() as { c: number }
      ).c;
      expect(count).toBe(1);

      const loaded = getDeviceSyncPreferences(db!, 1);
      expect(loaded!.syncType).toBe("custom");
      expect(loaded!.extraTrackPolicy).toBe("remove");

      const row2 = db!
        .prepare("SELECT updated_at FROM device_sync_preferences WHERE device_id = 1")
        .get() as { updated_at: string };
      expect(row2.updated_at >= row1.updated_at).toBe(true);
    }
  );

  it.skipIf(!canRunDbTests)(
    "malformed custom_selections_json decodes safely to empty arrays",
    () => {
      const prefs: DeviceSyncPreferences = {
        syncType: "full",
        extraTrackPolicy: "keep",
        includeMusic: true,
        includePodcasts: true,
        includeAudiobooks: true,
        includePlaylists: true,
        ignoreSpaceCheck: false,
        skipAlbumArtwork: false,
        selections: { albums: [], artists: [], genres: [], podcasts: [], audiobooks: [], playlists: [] },
      };
      saveDeviceSyncPreferences(db!, 1, prefs);
      db!
        .prepare("UPDATE device_sync_preferences SET custom_selections_json = 'NOT JSON' WHERE device_id = 1")
        .run();
      const loaded = getDeviceSyncPreferences(db!, 1);
      expect(loaded).not.toBeNull();
      expect(loaded!.selections.albums).toEqual([]);
      expect(loaded!.selections.artists).toEqual([]);
      expect(loaded!.selections.genres).toEqual([]);
    }
  );

  it.skipIf(!canRunDbTests)(
    "deleting a device cascades to remove its preferences row",
    () => {
      const prefs: DeviceSyncPreferences = {
        syncType: "full",
        extraTrackPolicy: "keep",
        includeMusic: true,
        includePodcasts: true,
        includeAudiobooks: true,
        includePlaylists: true,
        ignoreSpaceCheck: false,
        skipAlbumArtwork: false,
        selections: { albums: [], artists: [], genres: [], podcasts: [], audiobooks: [], playlists: [] },
      };
      saveDeviceSyncPreferences(db!, 1, prefs);
      expect(getDeviceSyncPreferences(db!, 1)).not.toBeNull();

      db!.prepare("DELETE FROM devices WHERE id = 1").run();
      expect(getDeviceSyncPreferences(db!, 1)).toBeNull();
    }
  );
});
