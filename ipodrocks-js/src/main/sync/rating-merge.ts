import Database from "better-sqlite3";
import { DeviceRatingChange, MergeOutcome } from "../../shared/types";

/**
 * Detect rating changes on a device by comparing current readings against the
 * last-known (baseline) values stored in device_track_ratings.
 */
export function detectDeviceChanges(
  currentDeviceRatings: Map<number, number>,
  lastSyncManifest: Map<number, number>
): DeviceRatingChange[] {
  const out: DeviceRatingChange[] = [];
  for (const [trackId, current] of currentDeviceRatings) {
    const baseline = lastSyncManifest.get(trackId);
    if (baseline === undefined) {
      out.push({ trackId, baseline: null, current, kind: "first_observation" });
    } else if (baseline !== current) {
      out.push({ trackId, baseline, current, kind: "device_edit" });
    }
  }
  return out;
}

/**
 * 3-way merge for a single track's rating.
 *
 * baseline            = last_seen_rating stored in device_track_ratings (shared ancestor)
 * deviceVal           = current reading from the device
 * libraryVal          = current tracks.rating (canonical)
 * libBaseAtLastSync   = tracks.rating at the time of this device's last sync
 * ratingVersionAtSync = tracks.rating_version at the time of this device's last sync
 * ratingVersionNow    = tracks.rating_version currently
 *
 * Half-step tolerance: if both sides changed but differ by ≤1 unit, silently take max.
 */
export function mergeRating(
  baseline: number | null,
  deviceVal: number,
  libraryVal: number | null,
  libBaseAtLastSync: number | null,
  ratingVersionAtSync: number,
  ratingVersionNow: number
): MergeOutcome {
  const deviceChanged = baseline !== deviceVal;
  const libraryChanged =
    libBaseAtLastSync !== libraryVal || ratingVersionNow > ratingVersionAtSync;

  if (baseline === null) {
    // First observation on this device.
    if (libraryVal === null) return { action: "adopt_device", value: deviceVal };
    if (libraryVal === deviceVal) return { action: "converged", value: libraryVal };
    // Library exists and device disagrees — caller decides (usually queue conflict).
    return { action: "conflict", canonical: libraryVal, deviceProposed: deviceVal };
  }

  if (!deviceChanged && !libraryChanged) return { action: "noop", value: libraryVal };
  if (deviceChanged && !libraryChanged) return { action: "adopt_device", value: deviceVal };
  if (!deviceChanged && libraryChanged) return { action: "propagate_lib", value: libraryVal! };
  if (deviceVal === libraryVal) return { action: "converged", value: libraryVal! };

  // Both changed, divergent — apply half-step tolerance.
  if (libraryVal !== null && Math.abs(deviceVal - libraryVal) <= 1) {
    return { action: "converged", value: Math.max(deviceVal, libraryVal) };
  }
  return { action: "conflict", canonical: libraryVal, deviceProposed: deviceVal };
}

interface DeviceTrackRatingRow {
  track_id: number;
  last_seen_rating: number | null;
  last_pushed_rating: number | null;
  last_seen_at: string | null;
  last_pushed_at: string | null;
  lib_rating: number | null;
  lib_rating_version: number;
}

/** Load the per-device baseline manifest from the DB. */
export function loadDeviceManifest(
  db: Database.Database,
  deviceId: number
): Map<number, number> {
  const rows = db
    .prepare(
      "SELECT track_id, last_seen_rating FROM device_track_ratings WHERE device_id = ?"
    )
    .all(deviceId) as { track_id: number; last_seen_rating: number | null }[];
  const manifest = new Map<number, number>();
  for (const r of rows) {
    if (r.last_seen_rating !== null) {
      manifest.set(r.track_id, r.last_seen_rating);
    }
  }
  return manifest;
}

export interface IngestResult {
  adopted: number;
  propagated: number;
  converged: number;
  conflicts: number;
  noop: number;
  massZeroFraction: number;
}

/**
 * Phase 1 INGEST: apply device ratings into canonical DB.
 *
 * Returns a summary and massZeroFraction so the caller can decide whether to
 * alert the user about a suspected Rockbox DB rebuild (fraction > 0.25).
 */
export function ingestDeviceRatings(
  db: Database.Database,
  deviceId: number,
  currentDeviceRatings: Map<number, number>
): IngestResult {
  const manifest = loadDeviceManifest(db, deviceId);
  const changes = detectDeviceChanges(currentDeviceRatings, manifest);

  const result: IngestResult = {
    adopted: 0,
    propagated: 0,
    converged: 0,
    conflicts: 0,
    noop: 0,
    massZeroFraction: 0,
  };

  if (currentDeviceRatings.size > 0) {
    const zeros = [...currentDeviceRatings.values()].filter((v) => v === 0).length;
    result.massZeroFraction = zeros / currentDeviceRatings.size;
  }

  if (changes.length === 0) return result;

  const trackIds = changes.map((c) => c.trackId);
  const placeholders = trackIds.map(() => "?").join(",");
  const trackRows = db
    .prepare(
      `SELECT id, rating, rating_version FROM tracks WHERE id IN (${placeholders})`
    )
    .all(...trackIds) as { id: number; rating: number | null; rating_version: number }[];
  const trackMap = new Map(trackRows.map((r) => [r.id, r]));

  // Load lib-base-at-last-sync from device_track_ratings
  const dtrRows = db
    .prepare(
      `SELECT track_id, last_seen_rating, last_pushed_rating FROM device_track_ratings WHERE device_id = ? AND track_id IN (${placeholders})`
    )
    .all(deviceId, ...trackIds) as DeviceTrackRatingRow[];
  const dtrMap = new Map(dtrRows.map((r) => [r.track_id, r]));

  const stmtUpsertRating = db.prepare(`
    UPDATE tracks SET
      rating = ?,
      rating_source_device_id = ?,
      rating_updated_at = CURRENT_TIMESTAMP,
      rating_version = rating_version + 1
    WHERE id = ?
  `);
  const stmtUpsertDtr = db.prepare(`
    INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_seen_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id, track_id) DO UPDATE SET
      last_seen_rating = excluded.last_seen_rating,
      last_seen_at = excluded.last_seen_at
  `);
  const stmtInsertEvent = db.prepare(`
    INSERT INTO rating_events (track_id, device_id, old_rating, new_rating, source)
    VALUES (?, ?, ?, ?, ?)
  `);
  const stmtInsertConflict = db.prepare(`
    INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const change of changes) {
      const track = trackMap.get(change.trackId);
      if (!track) continue;

      const dtr = dtrMap.get(change.trackId);
      const libBaseAtLastSync = dtr?.last_pushed_rating ?? null;
      const ratingVersionAtSync = 0; // conservative: assume version 0 if no baseline

      const outcome = mergeRating(
        change.baseline,
        change.current,
        track.rating,
        libBaseAtLastSync,
        ratingVersionAtSync,
        track.rating_version
      );

      // Always update last_seen in device_track_ratings
      stmtUpsertDtr.run(deviceId, change.trackId, change.current);

      switch (outcome.action) {
        case "adopt_device":
          stmtInsertEvent.run(change.trackId, deviceId, track.rating, outcome.value, "device_ingest");
          stmtUpsertRating.run(outcome.value, deviceId, change.trackId);
          result.adopted++;
          break;
        case "propagate_lib":
          // Library wins; no change to canonical. Will be pushed to device in Phase 3.
          result.propagated++;
          break;
        case "converged":
          if (outcome.value !== track.rating) {
            stmtInsertEvent.run(change.trackId, deviceId, track.rating, outcome.value, "merge");
            stmtUpsertRating.run(outcome.value, deviceId, change.trackId);
          }
          result.converged++;
          break;
        case "conflict":
          stmtInsertConflict.run(
            change.trackId,
            deviceId,
            change.current,
            change.baseline,
            track.rating
          );
          result.conflicts++;
          break;
        case "noop":
          result.noop++;
          break;
      }
    }
  })();

  return result;
}

/**
 * Phase 3 PROPAGATE: write canonical ratings to the device changelog format.
 * Returns a map of device-relative file paths to ratings that need to be written.
 *
 * The caller writes these to database_changelog.txt. We update last_pushed_* here.
 */
export function computeRatingPropagations(
  db: Database.Database,
  deviceId: number
): Map<number, number> {
  // Tracks where canonical diverges from what we last pushed, and no unresolved conflict exists.
  const rows = db
    .prepare(`
      SELECT t.id, t.rating
      FROM tracks t
      JOIN device_track_ratings dtr ON dtr.track_id = t.id AND dtr.device_id = ?
      WHERE t.rating IS NOT NULL
        AND (dtr.last_pushed_rating IS NULL OR dtr.last_pushed_rating != t.rating)
        AND NOT EXISTS (
          SELECT 1 FROM rating_conflicts rc
          WHERE rc.track_id = t.id AND rc.device_id = ? AND rc.resolved_at IS NULL
        )
    `)
    .all(deviceId, deviceId) as { id: number; rating: number }[];

  return new Map(rows.map((r) => [r.id, r.rating]));
}

/** Mark ratings as propagated after a successful changelog write. */
export function markRatingsPropagated(
  db: Database.Database,
  deviceId: number,
  trackIds: number[]
): void {
  if (trackIds.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO device_track_ratings (device_id, track_id, last_pushed_rating, last_pushed_at, last_seen_rating, last_seen_at)
    VALUES (?, ?, (SELECT rating FROM tracks WHERE id = ?), CURRENT_TIMESTAMP,
            COALESCE((SELECT last_seen_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?), NULL),
            COALESCE((SELECT last_seen_at FROM device_track_ratings WHERE device_id = ? AND track_id = ?), NULL))
    ON CONFLICT(device_id, track_id) DO UPDATE SET
      last_pushed_rating = (SELECT rating FROM tracks WHERE id = excluded.track_id),
      last_pushed_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const trackId of trackIds) {
      stmt.run(deviceId, trackId, trackId, deviceId, trackId, deviceId, trackId);
    }
  })();
}
