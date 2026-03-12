/**
 * Playback log ingestion — read Rockbox playback.log from device,
 * match to library, insert into playback_logs, aggregate playback_stats.
 */

import Database from "better-sqlite3";

import { parseRockboxPlaybackLogSafe } from "./rockbox-log-parser";
import { matchEventsToLibrary } from "./genius-engine";

export interface IngestResult {
  ingested: number;
  skipped: number;
}

/**
 * Read playback.log from device, match to library, insert into playback_logs,
 * and aggregate playback_stats. Only processes events that match library tracks.
 * Fails gracefully (returns { ingested: 0, skipped: 0 }) if file missing/empty.
 *
 * :param deviceId: devices.id for FK.
 * :param db: Database connection.
 * :param deviceMountPath: Root mount path of the device.
 * :param skipPlaybackLog: If true, skip reading (return immediately).
 * :param deviceName: Optional device name for playback_logs.device_name.
 * :returns: Counts of ingested and skipped (duplicate) events.
 */
export function readAndIngestPlaybackLog(
  deviceId: number,
  db: Database.Database,
  deviceMountPath: string,
  skipPlaybackLog: boolean,
  deviceName?: string
): IngestResult {
  if (skipPlaybackLog) {
    return { ingested: 0, skipped: 0 };
  }

  const events = parseRockboxPlaybackLogSafe(deviceMountPath);
  if (events.length === 0) {
    return { ingested: 0, skipped: 0 };
  }

  const matched = matchEventsToLibrary(events, db);
  if (matched.length === 0) {
    return { ingested: 0, skipped: 0 };
  }

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO playback_logs
     (device_id, device_db_id, device_name, timestamp_tick, elapsed_ms, total_ms,
      file_path, matched_track_id, completion_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let ingested = 0;
  let skipped = 0;

  const insertMany = db.transaction(() => {
    for (const m of matched) {
      const result = insertStmt.run(
        String(deviceId),
        deviceId,
        deviceName ?? null,
        m.timestamp,
        m.elapsedMs,
        m.totalMs,
        m.filePath,
        m.trackId,
        m.completionRatio
      );
      if (result.changes > 0) {
        ingested += 1;
      } else {
        skipped += 1;
      }
    }
  });

  insertMany();

  aggregatePlaybackStats(db);

  return { ingested, skipped };
}

/**
 * Rebuild playback_stats from playback_logs. Call after ingesting new events.
 */
function aggregatePlaybackStats(db: Database.Database): void {
  db.prepare(
    `INSERT OR REPLACE INTO playback_stats
     (track_id, total_plays, total_playtime_ms, avg_completion_rate,
      last_played_at, first_played_at, updated_at)
     SELECT matched_track_id AS track_id,
            COUNT(*) AS total_plays,
            SUM(elapsed_ms) AS total_playtime_ms,
            AVG(completion_rate) AS avg_completion_rate,
            datetime(MAX(timestamp_tick), 'unixepoch') AS last_played_at,
            datetime(MIN(timestamp_tick), 'unixepoch') AS first_played_at,
            CURRENT_TIMESTAMP AS updated_at
     FROM playback_logs
     WHERE matched_track_id IS NOT NULL
     GROUP BY matched_track_id`
  ).run();
}
