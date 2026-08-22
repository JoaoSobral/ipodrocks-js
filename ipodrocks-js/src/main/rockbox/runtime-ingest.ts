import type Database from "better-sqlite3";

import { buildDevicePathResolver } from "./device-path-match";
import {
  detectRuntimeCapability,
  readRuntimeIndex,
  type RockboxRuntimeEntry,
  type RuntimeDataState,
} from "./tagcache-index";

/**
 * Import Rockbox's runtime counters off a device.
 *
 * Rockbox maintains absolute totals per track, not a log of events, so an
 * import overwrites rather than appends and re-importing an unchanged device
 * changes nothing. That is the property the whole sync relies on.
 *
 * Two things Rockbox does not give us, and how they are handled:
 *
 * - **No dates.** Its ``lastplayed`` is a global counter that orders plays and
 *   nothing more. Where an import sees a track's play count rise, it records a
 *   delta stamped with the *host* clock — true, and unlike the device RTC,
 *   actually correct. The first import for a device has no baseline to compare
 *   against, so it records no deltas and leaves ``last_played_at`` null.
 * - **No skips.** A play is only counted once it has run 15 seconds, so a track
 *   skipped immediately leaves no trace at all. Nothing downstream may treat
 *   "no plays" as "always skipped".
 */

export interface RuntimeIngestResult {
  /** Runtime records matched to a library track and stored. */
  imported: number;
  /** Records whose device path matched no library track. */
  unmatched: number;
  /** Tracks whose play count rose since the previous import. */
  newPlays: number;
  /** Ratings read off the device, keyed by track id. */
  ratings: Map<number, number>;
  /** Runtime index id per track id, for writing ratings back in this pass. */
  idxIds: Map<number, number>;
  /** master_header.serial; a reset to 0 means the device database was rebuilt. */
  serial: number;
  /** Why nothing was imported, when nothing was. */
  state: RuntimeDataState;
}

function emptyResult(state: RuntimeDataState): RuntimeIngestResult {
  return {
    imported: 0,
    unmatched: 0,
    newPlays: 0,
    ratings: new Map(),
    idxIds: new Map(),
    serial: 0,
    state,
  };
}

/**
 * Average completion, as Rockbox's own ``autoscore`` computes it:
 * ``playtime / (length * playcount)``.
 *
 * Values above 1 are possible and legitimate — Rockbox credits up to 15
 * seconds of crossfade past the end of a track — so this is clamped rather
 * than trusted raw.
 */
function averageCompletion(entry: RockboxRuntimeEntry): number | null {
  if (entry.playCount <= 0 || entry.lengthMs <= 0) return null;
  const ratio = entry.playTimeMs / (entry.lengthMs * entry.playCount);
  return Math.max(0, Math.min(1, ratio));
}

export function readAndIngestRuntimeData(
  db: Database.Database,
  deviceId: number,
  mountPath: string,
  skip: boolean
): RuntimeIngestResult {
  if (skip) {
    return emptyResult({
      kind: "no-runtime-data",
      message: "Runtime data import is turned off for this device.",
    });
  }

  const state = detectRuntimeCapability(mountPath);
  if (state.kind !== "ok") return emptyResult(state);

  const snapshot = readRuntimeIndex(mountPath);
  if (!snapshot) {
    return emptyResult({
      kind: "unreadable",
      message: "Rockbox database could not be read.",
    });
  }

  const resolver = buildDevicePathResolver(db, deviceId);

  // What the previous import saw, so this one can tell what moved.
  const previous = new Map<number, { plays: number; playTimeMs: number }>();
  for (const row of db
    .prepare(
      "SELECT track_id, play_count, play_time_ms FROM device_runtime_stats WHERE device_id = ?"
    )
    .all(deviceId) as {
    track_id: number;
    play_count: number;
    play_time_ms: number;
  }[]) {
    previous.set(row.track_id, {
      plays: row.play_count,
      playTimeMs: row.play_time_ms,
    });
  }
  const isFirstImport = previous.size === 0;

  // One stamp for the whole run, so every row and delta it writes carries the
  // same observation time. Not used to identify the run -- two imports can land
  // in the same millisecond.
  const runStamp = new Date().toISOString();

  const upsert = db.prepare(
    `INSERT INTO device_runtime_stats
       (device_id, track_id, device_path, play_count, play_time_ms, rating,
        last_played_serial, length_ms, avg_completion, prev_play_count,
        last_played_at, first_seen_at, last_seen_at, imported_at)
     VALUES (@device_id, @track_id, @device_path, @play_count, @play_time_ms,
             @rating, @last_played_serial, @length_ms, @avg_completion,
             @prev_play_count, @last_played_at, @run_stamp,
             @run_stamp, @run_stamp)
     ON CONFLICT(device_id, track_id) DO UPDATE SET
       device_path        = excluded.device_path,
       play_count         = excluded.play_count,
       play_time_ms       = excluded.play_time_ms,
       rating             = excluded.rating,
       last_played_serial = excluded.last_played_serial,
       length_ms          = excluded.length_ms,
       avg_completion     = excluded.avg_completion,
       prev_play_count    = device_runtime_stats.play_count,
       -- excluded.last_played_at is set only when this pass saw the counter
       -- rise; otherwise the existing date stands, so an import that changed
       -- nothing cannot make a track look freshly played.
       last_played_at     = COALESCE(excluded.last_played_at,
                                     device_runtime_stats.last_played_at),
       last_seen_at       = excluded.last_seen_at,
       imported_at        = excluded.imported_at`
  );

  const insertDelta = db.prepare(
    `INSERT INTO runtime_play_deltas
       (device_id, track_id, observed_at, plays_delta, playtime_delta_ms)
     VALUES (?, ?, ?, ?, ?)`
  );

  const result = emptyResult(state);
  result.serial = snapshot.serial;

  db.transaction(() => {
    for (const entry of snapshot.entries) {
      const trackId = resolver.resolve(entry.devicePath);
      if (trackId == null) {
        result.unmatched++;
        continue;
      }

      const prev = previous.get(trackId);
      const prevCount = prev?.plays ?? 0;
      // A first import has nothing to compare against, so it establishes the
      // baseline rather than claiming every existing play happened just now.
      const played = !isFirstImport && entry.playCount > prevCount;

      upsert.run({
        device_id: deviceId,
        track_id: trackId,
        device_path: entry.devicePath,
        play_count: entry.playCount,
        play_time_ms: entry.playTimeMs,
        rating: entry.rating > 0 ? entry.rating : null,
        last_played_serial: entry.lastPlayedSerial,
        length_ms: entry.lengthMs,
        avg_completion: averageCompletion(entry),
        prev_play_count: prevCount,
        last_played_at: played ? runStamp : null,
        run_stamp: runStamp,
      });

      if (played) {
        insertDelta.run(
          deviceId,
          trackId,
          runStamp,
          entry.playCount - prevCount,
          Math.max(0, entry.playTimeMs - (prev?.playTimeMs ?? 0))
        );
        result.newPlays++;
      }

      result.imported++;
      result.idxIds.set(trackId, entry.idxId);
      // Rockbox has no null rating; 0 is how it says "unrated".
      result.ratings.set(trackId, entry.rating);
    }

    // Records for tracks the device no longer holds would keep counting toward
    // the library roll-up forever. Deleted by id in chunks rather than by a
    // NOT IN over everything we kept, which would outgrow SQLite's
    // bound-parameter limit on a real library.
    const stale = [...previous.keys()].filter((id) => !result.idxIds.has(id));
    for (let i = 0; i < stale.length; i += 500) {
      const chunk = stale.slice(i, i + 500);
      db.prepare(
        `DELETE FROM device_runtime_stats
          WHERE device_id = ? AND track_id IN (${chunk.map(() => "?").join(",")})`
      ).run(deviceId, ...chunk);
    }

    aggregateRuntimeStats(db);
  })();

  return result;
}

/**
 * Rebuild playback_stats from every device's runtime counters.
 *
 * A track can sit on more than one player, so plays and listening time are
 * summed across devices and average completion is weighted by play count
 * rather than averaged flat -- otherwise a device holding one play of a track
 * would count as much as one holding forty.
 *
 * last_played_at is the most recent host-clock observation across devices;
 * first_played_at is the earliest delta we ever recorded, which is when
 * iPodRocks started watching rather than when the track was first played, and
 * is null until a second import gives us one.
 */
export function aggregateRuntimeStats(db: Database.Database): void {
  db.prepare("DELETE FROM playback_stats").run();
  db.prepare(
    `INSERT INTO playback_stats
       (track_id, total_plays, total_playtime_ms, avg_completion_rate,
        last_played_at, first_played_at, updated_at)
     SELECT r.track_id,
            SUM(r.play_count),
            SUM(r.play_time_ms),
            CASE WHEN SUM(r.play_count) > 0
                 THEN SUM(COALESCE(r.avg_completion, 0) * r.play_count)
                      / SUM(r.play_count)
                 ELSE 0 END,
            MAX(r.last_played_at),
            (SELECT MIN(d.observed_at) FROM runtime_play_deltas d
              WHERE d.track_id = r.track_id),
            CURRENT_TIMESTAMP
       FROM device_runtime_stats r
      GROUP BY r.track_id`
  ).run();
}
