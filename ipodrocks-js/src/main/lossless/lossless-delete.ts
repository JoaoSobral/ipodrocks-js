/**
 * Deleting the files the lossless check flagged.
 *
 * The client names track **ids**, never paths: the path to remove is read off
 * the row here, and only a row whose stored verdict is one of the flagged ones
 * (and that the user has not marked OK) is touched. A smuggled-in path, or the
 * id of a genuine track, deletes nothing — the same "resolve the capability
 * server-side" rule as `player:prepare`.
 *
 * Files go to the OS trash where the host has one (the desktop app) and are
 * unlinked where it does not (the headless daemon) — the UI says which before
 * the user confirms. The library rows then go through
 * `LibraryScanner.removeTracksByPath()`, the scan's own complete cleanup.
 */
import * as fs from "fs";
import type Database from "better-sqlite3";
import { LOSSLESS_FLAGGED_VERDICTS, type LosslessDeleteResult } from "../../shared/types";
import { getHostShell } from "../host";
import { LibraryScanner } from "../library/library-scanner";

interface FlaggedRow {
  id: number;
  path: string;
}

export interface LosslessDeleteOutcome extends LosslessDeleteResult {
  removedTrackIds: number[];
  removedShadowPaths: string[];
}

/** Of `trackIds`, the rows still flagged and not overruled. */
export function resolveDeletableTracks(db: Database.Database, trackIds: number[]): FlaggedRow[] {
  const ids = [...new Set(trackIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const verdicts = LOSSLESS_FLAGGED_VERDICTS.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT id, path FROM tracks
      WHERE id = ? AND lossless_verdict IN (${verdicts}) AND COALESCE(lossless_override, 0) = 0`
  );
  const rows: FlaggedRow[] = [];
  for (const id of ids) {
    const row = stmt.get(id, ...LOSSLESS_FLAGGED_VERDICTS) as FlaggedRow | undefined;
    if (row) rows.push(row);
  }
  return rows;
}

export async function deleteFlaggedLosslessTracks(
  db: Database.Database,
  trackIds: number[]
): Promise<LosslessDeleteOutcome> {
  const rows = resolveDeletableTracks(db, trackIds);
  const shell = getHostShell();
  const gone: string[] = [];
  const result: LosslessDeleteOutcome = {
    deleted: 0,
    trashed: 0,
    permanent: 0,
    failed: [],
    removedTrackIds: [],
    removedShadowPaths: [],
  };

  for (const row of rows) {
    try {
      if (!fs.existsSync(row.path)) {
        // Already gone from disk: only the row is left to clean up.
        gone.push(row.path);
        continue;
      }
      let trashed = false;
      try {
        trashed = (await shell.trashItem(row.path)).trashed;
      } catch {
        trashed = false;
      }
      if (trashed) {
        result.trashed++;
      } else {
        fs.unlinkSync(row.path);
        result.permanent++;
      }
      gone.push(row.path);
    } catch (err) {
      result.failed.push({
        trackId: row.id,
        path: row.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (gone.length > 0) {
    const removed = new LibraryScanner(db).removeTracksByPath(gone);
    result.deleted = removed.filesRemoved;
    result.removedTrackIds = removed.removedTrackIds;
    result.removedShadowPaths = removed.removedShadowPaths;
  }
  return result;
}
