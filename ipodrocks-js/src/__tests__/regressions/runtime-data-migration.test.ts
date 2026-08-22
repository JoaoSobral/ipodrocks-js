/**
 * @vitest-environment node
 *
 * Upgrading an existing install to the runtime-data model.
 *
 * Statistics move from Rockbox's playback.log to the counters Rockbox keeps
 * itself. The two sources record the same plays under different rules — the log
 * counts anything over half a second, runtime data only counts a play that ran
 * fifteen — so they cannot be added and neither can be scaled into the other.
 * `playback_stats` therefore restarts from Rockbox's counters.
 *
 * What must hold: the reset happens exactly once (a second launch must not wipe
 * freshly imported statistics), and `playback_logs` is left alone — nothing
 * reads it any more, but the rows are the user's own history and this migration
 * does not get to delete them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

import { AppDatabase } from "../../main/database/database";
import { SCHEMA_SQL } from "../../main/database/schema";

/**
 * A database as a pre-2.3.0-beta release left it: playback log rows, statistics
 * aggregated from them, and none of the runtime-data tables or columns.
 */
function createLegacyDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

  db.prepare("DROP TABLE device_runtime_stats").run();
  db.prepare("DROP TABLE runtime_play_deltas").run();
  db.prepare("DROP INDEX IF EXISTS idx_device_synced_devpath").run();
  db.prepare("ALTER TABLE device_synced_tracks DROP COLUMN device_path").run();

  db.prepare(
    "INSERT INTO library_folders (name, path, content_type) VALUES ('Music', '/music', 'music')"
  ).run();
  db.prepare(
    "INSERT INTO tracks (path, filename, title, content_type, library_folder_id) VALUES (?, ?, ?, 'music', 1)"
  ).run("/music/a.mp3", "a.mp3", "A");

  for (let i = 0; i < 3; i++) {
    db.prepare(
      `INSERT INTO playback_logs
         (device_id, timestamp_tick, elapsed_ms, total_ms, file_path, matched_track_id, completion_rate)
       VALUES ('dev1', ?, 200000, 200000, '/Music/a.mp3', 1, 1.0)`
    ).run(1_700_000_000 + i);
  }
  db.prepare(
    "INSERT INTO playback_stats (track_id, total_plays, total_playtime_ms) VALUES (1, 3, 600000)"
  ).run();

  db.close();
}

function open(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true });
}

function columns(dbPath: string, table: string): string[] {
  const db = open(dbPath);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

function count(dbPath: string, table: string): number {
  const db = open(dbPath);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  db.close();
  return row.n;
}

describe("migrating an existing install to runtime data", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-runtime-migration-"));
    dbPath = path.join(dir, "ipodrock.db");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens a pre-runtime-data database and adds what it needs", () => {
    createLegacyDatabase(dbPath);
    expect(columns(dbPath, "device_synced_tracks")).not.toContain("device_path");

    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    expect(columns(dbPath, "device_synced_tracks")).toContain("device_path");
    expect(count(dbPath, "device_runtime_stats")).toBe(0);
    expect(count(dbPath, "runtime_play_deltas")).toBe(0);
  });

  it("clears the statistics aggregated from the old log", () => {
    createLegacyDatabase(dbPath);
    expect(count(dbPath, "playback_stats")).toBe(1);

    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    expect(count(dbPath, "playback_stats")).toBe(0);
  });

  it("leaves the user's playback log rows on disk", () => {
    createLegacyDatabase(dbPath);

    const app = new AppDatabase(dbPath);
    app.initialize();
    app.close();

    expect(count(dbPath, "playback_logs")).toBe(3);
  });

  it("does not wipe freshly imported statistics on the next launch", () => {
    createLegacyDatabase(dbPath);

    const first = new AppDatabase(dbPath);
    first.initialize();
    first.close();

    // Stand in for an import that ran after the upgrade.
    const seed = new Database(dbPath);
    seed
      .prepare(
        "INSERT INTO playback_stats (track_id, total_plays, total_playtime_ms) VALUES (1, 12, 2400000)"
      )
      .run();
    seed.close();

    const second = new AppDatabase(dbPath);
    second.initialize();
    second.close();

    const db = open(dbPath);
    const row = db
      .prepare("SELECT total_plays FROM playback_stats WHERE track_id = 1")
      .get() as { total_plays: number } | undefined;
    db.close();
    expect(row?.total_plays).toBe(12);
  });

  it("is a no-op on a fresh database", () => {
    const app = new AppDatabase(dbPath);
    expect(() => app.initialize()).not.toThrow();
    app.close();

    expect(columns(dbPath, "device_synced_tracks")).toContain("device_path");
    expect(count(dbPath, "playback_stats")).toBe(0);
  });
});
