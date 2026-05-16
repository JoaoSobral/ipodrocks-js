/**
 * In-memory SQLite database harness shared by behavioral + regression tests.
 *
 * Probes better-sqlite3 once on import so tests can skip when the native module
 * is compiled for Electron and the system Node can't load it.
 */
import { SCHEMA_SQL } from "../../main/database/schema";

export let canRunDbTests = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron; tests will skip via canRunDbTests */
}

export type TestDb = import("better-sqlite3").Database;

export function createTestDb(): TestDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const db = new Database(":memory:") as TestDb;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db["exec"](SCHEMA_SQL);
  applyTestMigrations(db);
  return db;
}

/**
 * Columns added in `AppDatabase.initialize()` migrations that are NOT in
 * `SCHEMA_SQL`. Replays them so test DBs match the runtime schema.
 */
function applyTestMigrations(db: TestDb): void {
  const ensureColumn = (table: string, column: string, ddl: string) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!rows.some((r) => r.name === column)) {
      db.prepare(ddl).run();
    }
  };
  ensureColumn(
    "devices",
    "skip_playback_log",
    "ALTER TABLE devices ADD COLUMN skip_playback_log INTEGER NOT NULL DEFAULT 0"
  );
  ensureColumn(
    "devices",
    "auto_podcasts_enabled",
    "ALTER TABLE devices ADD COLUMN auto_podcasts_enabled INTEGER NOT NULL DEFAULT 0"
  );
}

export function closeDb(db: TestDb | null | undefined): void {
  if (db) db.close();
}
