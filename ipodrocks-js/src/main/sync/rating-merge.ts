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
    //
    // Rockbox has no null rating: 0 is how it says "unrated". With no baseline
    // there is nothing to say whether a 0 is a rating the user cleared or one
    // they never gave, so it cannot be read as the device disagreeing with the
    // library — it is the device having no opinion. Reading it as the value
    // zero is what made a first sync queue one conflict for every track the
    // user had rated in iPodRocks and not on the player, and write a rating of
    // 0 over every unrated track in the library (issue #117).
    if (deviceVal === 0) {
      return libraryVal === null
        ? { action: "noop", value: null }
        : { action: "propagate_lib", value: libraryVal };
    }
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
}

/**
 * How confident we are that the device's Rockbox database was rebuilt, wiping
 * the ratings it held.
 *
 * Worth being sure about in both directions: importing a wiped database clears
 * the user's library ratings, and crying rebuild on a healthy one blocks the
 * import they asked for.
 */
export interface RebuildSuspicion {
  looksRebuilt: boolean;
  /** Tracks this device was last seen holding a rating for. */
  previouslyRated: number;
  /** How many of those now read as unrated. */
  cleared: number;
  /** Why, in words, for the sync log. Null when nothing looks wrong. */
  reason: string | null;
}

/**
 * Decide whether the device's ratings can be trusted, *before* anything is
 * merged into the library.
 *
 * The old test asked what fraction of the device's ratings read 0. That is not
 * a rebuild signal, it is a description of a normal library: Rockbox has no
 * null rating, so every track the user never rated reads 0, and the reporter's
 * player — 43 rated tracks out of 2411 — scored 0.98 and tripped the warning on
 * every sync (issue #117). Worse, the check ran *after* the merge, so the
 * "ratings were skipped" it printed was not true of anything.
 *
 * What a rebuild actually looks like is loss: tracks this device was last seen
 * holding a rating for now read as unrated. A library that is simply mostly
 * unrated has nothing to lose and scores zero.
 */
export function detectRebuiltDatabase(
  db: Database.Database,
  deviceId: number,
  currentDeviceRatings: Map<number, number>,
  serial: number
): RebuildSuspicion {
  // Rockbox's own signal, and the only one available on a first import: the
  // global play counter resets to 0 when the database is rebuilt. Ratings that
  // survived the rebuild (Rockbox flags those records RESURRECTED) come back
  // non-zero, so a reset serial with ratings still on the device is not a loss
  // and must not be reported as one.
  if (serial === 0 && [...currentDeviceRatings.values()].every((v) => v === 0)) {
    return {
      looksRebuilt: true,
      previouslyRated: 0,
      cleared: 0,
      reason:
        "the device's play counter has reset to zero and it holds no ratings at all",
    };
  }

  const manifest = loadDeviceManifest(db, deviceId);
  let previouslyRated = 0;
  let cleared = 0;
  for (const [trackId, current] of currentDeviceRatings) {
    const baseline = manifest.get(trackId);
    if (baseline === undefined || baseline <= 0) continue;
    previouslyRated++;
    if (current === 0) cleared++;
  }

  // Below the sample floor a couple of ratings cleared by hand would look like
  // a wipe. A real rebuild clears every one of them, so the bar is set where
  // ordinary editing cannot reach it.
  const looksRebuilt =
    previouslyRated >= REBUILD_MIN_SAMPLE &&
    cleared / previouslyRated > REBUILD_CLEARED_FRACTION;

  return {
    looksRebuilt,
    previouslyRated,
    cleared,
    reason: looksRebuilt
      ? `${cleared} of the ${previouslyRated} tracks this device had rated now read as unrated`
      : null,
  };
}

/** Fewest previously-rated tracks that can support a rebuild verdict. */
const REBUILD_MIN_SAMPLE = 5;
/** Share of them that must have been cleared for it to be a wipe, not editing. */
const REBUILD_CLEARED_FRACTION = 0.75;

export interface RebuildRepairResult {
  /** device_track_ratings rows whose last_pushed_rating was cleared. */
  invalidated: number;
  /** Previously-open rating_conflicts for this device closed as moot. */
  conflictsResolved: number;
}

/**
 * Undo what a rebuild verdict from {@link detectRebuiltDatabase} invalidates, so
 * Phase 3 can repair the device in the *same* sync that caught the wipe.
 *
 * Phase 3's {@link computeRatingPropagations} only re-pushes a track when
 * `last_pushed_rating` disagrees with (or is unset against) `tracks.rating`. A
 * rebuild physically clears the device's values without touching
 * `tracks.rating`, so if a rating had already been pushed successfully before
 * the rebuild, `last_pushed_rating` still matches — the query excludes it, and
 * it is never re-sent. Left alone, that also means `last_seen_rating` never
 * gets updated (Phase 1 ingest is skipped whole on a rebuild verdict), so the
 * next sync reads the same wiped device against the same stale baseline and
 * calls it a rebuild again, forever (issue #117 follow-up).
 *
 * Clearing `last_pushed_rating` is enough to make every currently-rated track
 * look "unpushed" again to Phase 3, which re-sends them this sync using the
 * ordinary propagation path — no new merge logic, and {@link markRatingsPropagated}
 * repopulates `last_pushed_rating` correctly right after.
 *
 * `last_seen_rating` is deliberately left untouched: once Phase 3 repairs the
 * device this sync, its on-disk values become correct again, so the next
 * sync's {@link detectRebuiltDatabase} — which compares fresh readings against
 * this same baseline — no longer sees any previously-rated track read as
 * cleared, and the rebuild verdict clears on its own.
 *
 * Any conflict left open against this device from before the rebuild is also
 * moot: the device no longer holds the value it was disputing, so it is
 * closed as `canonical_wins`, the same resolution `rating-tag-overwrite.ts`
 * uses when the library is made authoritative outright.
 */
export function invalidatePushedRatings(
  db: Database.Database,
  deviceId: number
): RebuildRepairResult {
  const stmtClearPushed = db.prepare(`
    UPDATE device_track_ratings
    SET last_pushed_rating = NULL
    WHERE device_id = ? AND last_pushed_rating IS NOT NULL
  `);
  const stmtResolveConflicts = db.prepare(`
    UPDATE rating_conflicts
    SET resolved_at = CURRENT_TIMESTAMP, resolution = 'canonical_wins'
    WHERE device_id = ? AND resolved_at IS NULL
  `);

  let invalidated = 0;
  let conflictsResolved = 0;
  db.transaction(() => {
    invalidated = stmtClearPushed.run(deviceId).changes;
    conflictsResolved = stmtResolveConflicts.run(deviceId).changes;
  })();

  return { invalidated, conflictsResolved };
}

/**
 * Phase 1 INGEST: apply device ratings into canonical DB.
 *
 * Call {@link detectRebuiltDatabase} first: this merges, and a merge from a
 * wiped device is not something a later warning can undo.
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
  };

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
