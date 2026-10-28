/**
 * @vitest-environment node
 *
 * The Start Sync warning for an Orphan & Reset Policy other than Keep has a
 * "do not show this warning again for this device" box, stored in
 * `device_sync_preferences.hide_orphan_warning`.
 *
 * Pinned here:
 * - a new device has no preferences row, and its policy defaults to Keep;
 * - the flag has its own writer, and the save every `sync:start` performs
 *   leaves it alone — otherwise the very next sync would bring the warning
 *   back (or, written the other way round, a sync could hide it);
 * - the writer creates the row for a device that has never synced;
 * - `initialize()` adds the column to a database from before it existed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";
import { canRunDbTests, closeDb, createTestDb, type TestDb } from "../harness";
import {
  emptySelections,
  getDeviceSyncPreferences,
  saveDeviceSyncPreferences,
  setOrphanWarningHidden,
} from "../../main/sync/device-sync-preferences";
import type { DeviceSyncPreferences } from "../../shared/types";

const itDb = it.skipIf(!canRunDbTests);

function seedDevice(db: TestDb, id: number): void {
  db.prepare(
    `INSERT INTO devices (id, name, mount_path, music_folder, podcast_folder,
     audiobook_folder, playlist_folder, model_id, default_codec_config_id,
     default_transfer_mode_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)`
  ).run(id, `Dev${id}`, `/mnt/dev${id}`, "Music", "Podcasts", "Audiobooks", "Playlists");
}

const PREFS: DeviceSyncPreferences = {
  syncType: "full",
  extraTrackPolicy: "remove",
  includeMusic: true,
  includePodcasts: true,
  includeAudiobooks: true,
  includePlaylists: true,
  preserveFolderStructure: true,
  albumGrouping: "album-artist",
  buildRockboxDatabase: false,
  selections: emptySelections(),
};

describe("orphan-policy warning preference", () => {
  let db: TestDb | null = null;
  let dir: string | null = null;

  afterEach(() => {
    closeDb(db);
    db = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  itDb("a new device has no saved preferences, and the row default policy is keep", () => {
    db = createTestDb();
    seedDevice(db, 1);
    expect(getDeviceSyncPreferences(db, 1)).toBeNull();

    // The writer creates the row with every other column at its default.
    setOrphanWarningHidden(db, 1, false);
    const prefs = getDeviceSyncPreferences(db, 1);
    expect(prefs?.extraTrackPolicy).toBe("keep");
    expect(prefs?.hideOrphanWarning).toBe(false);
  });

  itDb("is remembered per device", () => {
    db = createTestDb();
    seedDevice(db, 1);
    seedDevice(db, 2);
    setOrphanWarningHidden(db, 1, true);

    expect(getDeviceSyncPreferences(db, 1)?.hideOrphanWarning).toBe(true);
    expect(getDeviceSyncPreferences(db, 2)).toBeNull();
  });

  itDb("survives the preference save every sync performs", () => {
    db = createTestDb();
    seedDevice(db, 1);
    saveDeviceSyncPreferences(db, 1, PREFS);
    setOrphanWarningHidden(db, 1, true);

    // sync:start saves the panel's settings, which carry no flag at all.
    saveDeviceSyncPreferences(db, 1, { ...PREFS, extraTrackPolicy: "prompt" });
    const after = getDeviceSyncPreferences(db, 1);
    expect(after?.hideOrphanWarning).toBe(true);
    expect(after?.extraTrackPolicy).toBe("prompt");

    // ...and one that does carry it cannot change it either.
    saveDeviceSyncPreferences(db, 1, { ...PREFS, hideOrphanWarning: false });
    expect(getDeviceSyncPreferences(db, 1)?.hideOrphanWarning).toBe(true);

    setOrphanWarningHidden(db, 1, false);
    expect(getDeviceSyncPreferences(db, 1)?.hideOrphanWarning).toBe(false);
  });

  it("initialize() adds the column to a database from before it existed", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-orphan-warning-migration-"));
    const dbPath = path.join(dir, "ipodrock.db");
    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    const raw = new Database(dbPath);
    raw.prepare("ALTER TABLE device_sync_preferences DROP COLUMN hide_orphan_warning").run();
    raw.close();

    const upgraded = new AppDatabase(dbPath);
    expect(() => upgraded.initialize()).not.toThrow();
    upgraded.close();

    const check = new Database(dbPath);
    const cols = (
      check.prepare("PRAGMA table_info(device_sync_preferences)").all() as { name: string }[]
    ).map((c) => c.name);
    check.close();
    expect(cols).toContain("hide_orphan_warning");
  });
});
