/**
 * Activity logger — records user operations for the dashboard Recent Activity.
 * Stores last 100 operations with timestamp.
 */

import type Database from "better-sqlite3";

const MAX_ENTRIES = 100;

export type ActivityOperation =
  | "sync"
  | "library_scan"
  | "add_folder"
  | "remove_folder"
  | "add_device"
  | "update_device"
  // Retired in 2.3.0-beta but kept in the union: the string is persisted in
  // the activity table, and dropping it would stop existing rows rendering.
  | "read_playback_log"
  | "read_runtime_data"
  | "playlist_generated"
  | "playlist_deleted"
  | "playlist_repaired"
  | "podcast_subscribed"
  | "podcast_downloaded"
  | "podcast_episodes_deleted"
  | "audiobook_subscribed"
  | "audiobook_unsubscribed"
  | "shadow_prune"
  | "mpc_tag_repair";

export interface ActivityEntry {
  id: number;
  operation: string;
  detail: string | null;
  created_at: string;
}

/**
 * Log an activity. Trims to last MAX_ENTRIES after insert.
 */
export function logActivity(
  db: Database.Database,
  operation: ActivityOperation,
  detail?: string
): void {
  try {
    db.prepare(
      "INSERT INTO activity_log (operation, detail) VALUES (?, ?)"
    ).run(operation, detail ?? null);

    const count = db.prepare("SELECT COUNT(*) as n FROM activity_log").get() as {
      n: number;
    };
    if (count.n > MAX_ENTRIES) {
      const toDelete = count.n - MAX_ENTRIES;
      db.prepare(
        `DELETE FROM activity_log WHERE id IN (
          SELECT id FROM (
            SELECT id FROM activity_log ORDER BY id ASC LIMIT ?
          )
        )`
      ).run(toDelete);
    }
  } catch (err) {
    console.warn("[activity] Log failed:", err);
  }
}

/**
 * Get the last N activity entries, newest first.
 */
export function getRecentActivity(
  db: Database.Database,
  limit: number = MAX_ENTRIES
): ActivityEntry[] {
  return db
    .prepare(
      `SELECT id, operation, detail, created_at
       FROM activity_log
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as ActivityEntry[];
}
