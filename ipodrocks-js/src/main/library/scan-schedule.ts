/**
 * When was the library last scanned, and is it time to ask about it?
 *
 * The answer cannot come from `activity_log`: that table is pruned to its most
 * recent rows, so a busy install forgets its last scan and would then nag
 * forever. The time lives in `app_settings` (`last_library_scan_at`), written
 * by a scan that finished without being cancelled. A database from before this
 * key existed is seeded once from the newest `library_scan` activity row, so
 * an upgrade does not open with "you have never scanned".
 */
import type Database from "better-sqlite3";

import type { LibraryPrefs } from "../utils/prefs";

export const LAST_SCAN_KEY = "last_library_scan_at";

/** How stale the library may get, and how long "No" keeps the reminder quiet. */
export const SCAN_REMINDER_INTERVAL_MS = 10 * 24 * 60 * 60 * 1000;

/** SQLite's `CURRENT_TIMESTAMP` is UTC with no zone marker. */
function parseSqliteUtc(value: string): number | null {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Unix ms of the last completed scan, or null for a library never scanned. */
export function getLastLibraryScanAt(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(LAST_SCAN_KEY) as
    | { value: string }
    | undefined;
  if (row) return parseSqliteUtc(row.value);

  const logged = db
    .prepare("SELECT MAX(created_at) AS at FROM activity_log WHERE operation = 'library_scan'")
    .get() as { at: string | null } | undefined;
  const at = logged?.at ? parseSqliteUtc(logged.at) : null;
  if (at !== null) recordLibraryScan(db, at);
  return at;
}

export function recordLibraryScan(db: Database.Database, at: number = Date.now()): void {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)"
  ).run(LAST_SCAN_KEY, new Date(at).toISOString());
}

export interface ScanReminder {
  due: boolean;
  /** ISO time of the last completed scan; null when there has never been one. */
  lastScanAt: string | null;
}

/**
 * Should the user be asked to scan? Never when the startup scan is on (it
 * keeps the library current by itself) or when there is nothing to scan.
 * A library that has folders but was never scanned is due.
 */
export function scanReminder(
  db: Database.Database,
  prefs: LibraryPrefs,
  now: number = Date.now()
): ScanReminder {
  const last = getLastLibraryScanAt(db);
  const lastScanAt = last === null ? null : new Date(last).toISOString();
  if (prefs.scanOnStartup) return { due: false, lastScanAt };
  if ((prefs.scanReminderSnoozeUntil ?? 0) > now) return { due: false, lastScanAt };
  const folders = db.prepare("SELECT COUNT(*) AS n FROM library_folders").get() as { n: number };
  if (folders.n === 0) return { due: false, lastScanAt };
  return { due: last === null || now - last >= SCAN_REMINDER_INTERVAL_MS, lastScanAt };
}
