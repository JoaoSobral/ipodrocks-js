/**
 * Phase 3 of the sync: push the library's canonical ratings onto the device.
 *
 * This lived inline in `ipc/sync.ts`, which is why three defects sat in it
 * unnoticed through issue #117's whole round of rating work: nothing could test
 * it. `behaviors/rating-writeback.test.ts` re-implemented the loop in a local
 * helper and tested *that*, so the real one was never run by anything but a
 * user with an iPod (issue #138).
 *
 * The three, all of which shared the shape "the rating silently never arrives
 * and is never retried":
 *
 * - A track with no entry in the device's database was skipped, correctly, but
 *   silently — the reporter's newly copied album simply had no ratings and the
 *   log said nothing at all.
 * - `writeRating` returning false was recorded as pushed. False meant both "the
 *   device already holds it" and "there is no index / Rockbox is mid-update", so
 *   a failed write set `last_pushed_rating` and
 *   {@link computeRatingPropagations} then excluded that track forever. That is
 *   now {@link RatingWriteResult}, and only `written`/`unchanged` count.
 * - One bad record threw out of the loop, and because `markRatingsPropagated`
 *   ran after it, every rating written before the throw was recorded as unpushed
 *   too. Each track now fails alone.
 */
import Database from "better-sqlite3";

import { writeRating } from "../rockbox/tagcache-index";
import { computeRatingPropagations, markRatingsPropagated } from "./rating-merge";

export interface PropagationReport {
  /** Ratings whose bytes actually changed on the device. */
  written: number;
  /** Tracks the device already held the canonical rating for. */
  alreadyCorrect: number;
  /**
   * Tracks with a rating to push that the device's database does not list yet —
   * everything copied during this very sync, since Rockbox only learns about a
   * file when its database is updated. Deliberately *not* marked as pushed, so
   * the next sync after the user updates the database on the player sends them.
   */
  notInDeviceDb: number;
  /** Nothing could be written at all: no index, or Rockbox is mid-update. */
  unavailable: number;
  /** Tracks whose write threw. Counted, not fatal to the rest. */
  failed: number;
}

/**
 * Write every rating the library holds that the device does not, and report
 * precisely what happened to each.
 *
 * `idxIds` must come from *this* sync's runtime read: a "Database → Initialize
 * now" on the player renumbers every record, so a cached index id would address
 * the wrong track.
 */
export function propagateRatingsToDevice(
  db: Database.Database,
  deviceId: number,
  mountPath: string,
  idxIds: Map<number, number>
): PropagationReport {
  const report: PropagationReport = {
    written: 0,
    alreadyCorrect: 0,
    notInDeviceDb: 0,
    unavailable: 0,
    failed: 0,
  };

  const propagations = computeRatingPropagations(db, deviceId);
  if (propagations.size === 0) return report;

  // Only the tracks the device actually took the value for. A track left out
  // here keeps `last_pushed_rating` unset and is retried on the next sync,
  // which is the whole repair mechanism for a write that could not happen.
  const pushed: number[] = [];

  for (const [trackId, rating] of propagations) {
    const idxId = idxIds.get(trackId);
    if (idxId === undefined) {
      report.notInDeviceDb++;
      continue;
    }

    try {
      const outcome = writeRating(mountPath, idxId, rating);
      if (outcome === "written") {
        report.written++;
        pushed.push(trackId);
      } else if (outcome === "unchanged") {
        report.alreadyCorrect++;
        pushed.push(trackId);
      } else {
        report.unavailable++;
      }
    } catch (err) {
      // An out-of-range index id or a malformed record is this one track's
      // problem. Letting it escape used to discard every other write in the
      // same sync, because nothing had been marked yet.
      report.failed++;
      console.error(
        `[rating-propagate] could not write rating for track ${trackId}:`,
        err
      );
    }
  }

  if (pushed.length > 0) markRatingsPropagated(db, deviceId, pushed);

  return report;
}
