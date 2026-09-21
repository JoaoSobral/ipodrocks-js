import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { getUserDataPath } from "../main/host";

/**
 * The server's own SQLite file, separate from `ipodrock.db`.
 *
 * Kept apart on purpose. `AppDatabase.initialize()` runs `SCHEMA_SQL` before
 * any migration, which is a documented hazard every time a column and its index
 * are added together (see CLAUDE.md); adding four auth tables and their indexes
 * to that file buys nothing and puts login next to the library's upgrade path.
 * Sessions and identities also have a different lifetime from the library —
 * deleting this file logs everyone out and nothing else.
 */

const DB_FILENAME = "ipodrocks-server.db";

const SCHEMA_SQL = `
-- The identity allowlist. OAuth proves who someone is; this table is what says
-- they are allowed in. The subject column is the provider's stable user id, not the
-- email address, which users can change.
CREATE TABLE IF NOT EXISTS server_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  is_owner INTEGER NOT NULL DEFAULT 0,
  -- scrypt hash, only for provider='local'
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE(provider, subject)
);

CREATE TABLE IF NOT EXISTS server_sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_sessions_expires
  ON server_sessions(expires_at);

-- One row per failed attempt, swept by the rate limiter. Keyed by both the
-- remote address and the account being attempted, so neither a single IP
-- spraying accounts nor a botnet targeting one account gets a free pass.
CREATE TABLE IF NOT EXISTS server_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_login_attempts
  ON server_login_attempts(bucket, attempted_at);

CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db: Database.Database | null = null;

export function getServerDb(): Database.Database {
  if (db) return db;
  const dir = getUserDataPath();
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, DB_FILENAME);
  const conn = new Database(dbPath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA_SQL);
  // This file *is* the authentication store: the session signing secret, every
  // live session id and every local password hash. `node-host.ts` already
  // 0600s `secret.key` beside it; nothing did the same here, so under the
  // default 0022 umask it was world-readable and secret-plus-live-sid is
  // enough to forge the owner's cookie. WAL puts the same content in the
  // sidecars, so they get the same treatment.
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* not every platform or filesystem honours this, and the sidecars may
         not exist yet; the systemd unit sets UMask=0077 as the real backstop */
    }
  }
  db = conn;
  return conn;
}

/** Closes and forgets the connection. A server stop, and tests. */
export function closeServerDb(): void {
  try {
    db?.close();
  } catch {
    // already closed
  }
  db = null;
}

export function getSetting(key: string): string | null {
  const row = getServerDb()
    .prepare("SELECT value FROM server_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getServerDb()
    .prepare(
      "INSERT INTO server_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}
