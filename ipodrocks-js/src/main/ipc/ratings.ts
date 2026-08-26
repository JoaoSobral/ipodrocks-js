import { ipcMain } from "electron";
import { safe, getLibrary } from "./common";

export function registerRatingsHandlers(): void {
  ipcMain.handle(
    "ratings:setTrackRating",
    safe("ratings:setTrackRating", async (_event, trackId: number, rating: number | null) => {
      const db = getLibrary().getConnection();
      const track = db
        .prepare("SELECT id, rating FROM tracks WHERE id = ?")
        .get(trackId) as { id: number; rating: number | null } | undefined;
      if (!track) throw new Error(`Track ${trackId} not found`);

      const validRating =
        rating === null ? null : Math.max(0, Math.min(10, Math.round(rating)));

      db.prepare(`
        UPDATE tracks SET
          rating = ?,
          rating_source_device_id = NULL,
          rating_updated_at = CURRENT_TIMESTAMP,
          rating_version = rating_version + 1
        WHERE id = ?
      `).run(validRating, trackId);

      db.prepare(`
        INSERT INTO rating_events (track_id, device_id, old_rating, new_rating, source)
        VALUES (?, NULL, ?, ?, 'library_ui')
      `).run(trackId, track.rating, validRating);

      return { ok: true };
    })
  );

  ipcMain.handle(
    "ratings:getConflicts",
    safe("ratings:getConflicts", async () => {
      const db = getLibrary().getConnection();
      const rows = db
        .prepare(`
          SELECT rc.id, rc.track_id, rc.device_id, rc.reported_rating,
                 rc.baseline_rating, rc.canonical_rating, rc.reported_at,
                 rc.resolved_at, rc.resolution,
                 t.title, t.path,
                 COALESCE(a.name, 'Unknown Artist') as artist,
                 d.name as device_name
          FROM rating_conflicts rc
          JOIN tracks t ON t.id = rc.track_id
          LEFT JOIN artists a ON a.id = t.artist_id
          JOIN devices d ON d.id = rc.device_id
          WHERE rc.resolved_at IS NULL
          ORDER BY rc.reported_at DESC
        `)
        .all();
      return rows;
    })
  );

  ipcMain.handle(
    "ratings:resolveConflict",
    safe(
      "ratings:resolveConflict",
      async (
        _event,
        conflictId: number,
        resolution: ConflictResolution,
        manualRating?: number
      ) => {
        const db = getLibrary().getConnection();
        const conflict = db
          .prepare("SELECT * FROM rating_conflicts WHERE id = ?")
          .get(conflictId) as ConflictRow | undefined;
        if (!conflict) throw new Error(`Conflict ${conflictId} not found`);

        let newRating: number | null = null;
        db.transaction(() => {
          newRating = applyResolution(db, conflict, resolution, manualRating);
        })();

        return { ok: true, newRating };
      }
    )
  );

  ipcMain.handle(
    "ratings:resolveAllConflicts",
    safe(
      "ratings:resolveAllConflicts",
      async (
        _event,
        resolution: "device_wins" | "canonical_wins",
        deviceId?: number | null
      ) => {
        // One decision for the whole queue. A first sync can raise a conflict
        // per rated track, and answering the same question several hundred
        // times one row at a time is not a decision, it is data entry.
        const db = getLibrary().getConnection();
        const conflicts = db
          .prepare(
            `SELECT * FROM rating_conflicts
              WHERE resolved_at IS NULL
                AND (? IS NULL OR device_id = ?)
              ORDER BY id`
          )
          .all(deviceId ?? null, deviceId ?? null) as ConflictRow[];

        // One transaction for the lot: a partly-applied bulk answer would
        // leave the user unable to tell which half they had already decided.
        db.transaction(() => {
          for (const conflict of conflicts) {
            applyResolution(db, conflict, resolution);
          }
        })();

        return { ok: true, resolved: conflicts.length };
      }
    )
  );
}

type ConflictResolution = "device_wins" | "canonical_wins" | "manual";

interface ConflictRow {
  id: number;
  track_id: number;
  device_id: number;
  reported_rating: number;
  canonical_rating: number | null;
}

/**
 * Apply one conflict's resolution. Caller owns the transaction, so the single
 * and bulk handlers cannot drift apart on what "device wins" means.
 */
function applyResolution(
  db: ReturnType<ReturnType<typeof getLibrary>["getConnection"]>,
  conflict: ConflictRow,
  resolution: ConflictResolution,
  manualRating?: number
): number | null {
  const newRating =
    resolution === "device_wins"
      ? conflict.reported_rating
      : resolution === "canonical_wins"
        ? conflict.canonical_rating
        : (manualRating ?? conflict.canonical_rating);

  if (newRating !== conflict.canonical_rating) {
    db.prepare(
      `UPDATE tracks SET
         rating = ?,
         rating_updated_at = CURRENT_TIMESTAMP,
         rating_version = rating_version + 1
       WHERE id = ?`
    ).run(newRating, conflict.track_id);

    db.prepare(
      `INSERT INTO rating_events (track_id, device_id, old_rating, new_rating, source)
       VALUES (?, ?, ?, ?, 'conflict_resolved')`
    ).run(conflict.track_id, conflict.device_id, conflict.canonical_rating, newRating);
  }

  db.prepare(
    `UPDATE rating_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ?
      WHERE id = ?`
  ).run(resolution, conflict.id);

  return newRating;
}
