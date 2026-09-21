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

import type { DeviceFs } from "../devices/fs/device-fs";
import {
  beginIndexBackupRun,
  writeRating,
  writeRatingOn,
} from "../rockbox/tagcache-index";
import { computeRatingPropagations, markRatingsPropagated } from "./rating-merge";

export interface PropagationReport {
  /** Ratings whose bytes actually changed on the device. */
  written: number;
  /** Tracks the device already held the canonical rating for. */
  alreadyCorrect: number;
  /**
   * Tracks this device holds, with a rating to push, that its database does not
   * list yet — everything copied during this very sync, since Rockbox only
   * learns a file exists when its database is updated. Deliberately *not* marked
   * as pushed, so the next sync after the user updates the database sends them.
   *
   * This is the only count the sync log turns into an instruction, so it must
   * mean what it says — hence `selectedTrackIds`.
   */
  notInDeviceDb: number;
  /**
   * Rated tracks this sync did not send here at all — everything outside a
   * partial selection, and the whole library minus the contents of a second,
   * smaller player. Not a problem and never logged; counted only to keep them
   * out of {@link notInDeviceDb}, which without the split announced "19,500
   * rating(s) are waiting for the device's database" on every sync of a
   * 500-track player.
   */
  notOnDevice: number;
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
 *
 * `selectedTrackIds` is the set of library track ids this sync sent to this
 * device — the caller's own selection, after any shadow remap. It is used only
 * to tell {@link PropagationReport.notInDeviceDb} from
 * {@link PropagationReport.notOnDevice}, never to decide what to write.
 *
 * It has to be the selection rather than anything read back from the database:
 * `device_synced_tracks` looks like the obvious source and is not, because only
 * the `device:check` handler ever writes it. On a device the user syncs without
 * ever running a check that table is empty, and every rating waiting on the
 * device's database would be silently filed as "not on this device".
 */
/**
 * What Phase 3 would write, before a byte moves.
 *
 * Split out so the local path and the browser-held one make the *same*
 * decisions: everything that reads the database and counts a track as
 * `notInDeviceDb` or `notOnDevice` happens here, once, and the two loops below
 * differ only in how they issue a write.
 */
function planPropagation(
  db: Database.Database,
  deviceId: number,
  idxIds: Map<number, number>,
  selectedTrackIds: ReadonlySet<number>
): { writes: { trackId: number; idxId: number; rating: number }[]; report: PropagationReport } {
  const report: PropagationReport = {
    written: 0,
    alreadyCorrect: 0,
    notInDeviceDb: 0,
    notOnDevice: 0,
    unavailable: 0,
    failed: 0,
  };

  const writes: { trackId: number; idxId: number; rating: number }[] = [];
  const propagations = computeRatingPropagations(db, deviceId);

  for (const [trackId, rating] of propagations) {
    const idxId = idxIds.get(trackId);
    if (idxId === undefined) {
      if (selectedTrackIds.has(trackId)) report.notInDeviceDb++;
      else report.notOnDevice++;
      continue;
    }
    writes.push({ trackId, idxId, rating });
  }

  return { writes, report };
}

/** Records one write's outcome. Shared, so the two loops cannot disagree. */
function recordOutcome(
  report: PropagationReport,
  pushed: number[],
  trackId: number,
  outcome: "written" | "unchanged" | "unavailable"
): void {
  if (outcome === "written") {
    report.written++;
    pushed.push(trackId);
  } else if (outcome === "unchanged") {
    // Only `written`/`unchanged` may be marked. Recording an `unavailable` as
    // pushed is issue #138: `last_pushed_rating` then matches `tracks.rating`,
    // the query excludes the track, and the rating never arrives on any later
    // sync.
    report.alreadyCorrect++;
    pushed.push(trackId);
  } else {
    report.unavailable++;
  }
}

function noteFailure(
  report: PropagationReport,
  trackId: number,
  err: unknown
): void {
  // An out-of-range index id or a malformed record is this one track's
  // problem. Letting it escape used to discard every other write in the
  // same sync, because nothing had been marked yet.
  report.failed++;
  console.error(
    `[rating-propagate] could not write rating for track ${trackId}:`,
    err
  );
}

export function propagateRatingsToDevice(
  db: Database.Database,
  deviceId: number,
  mountPath: string,
  idxIds: Map<number, number>,
  selectedTrackIds: ReadonlySet<number>
): PropagationReport {
  const { writes, report } = planPropagation(db, deviceId, idxIds, selectedTrackIds);
  if (writes.length === 0 && report.notInDeviceDb === 0 && report.notOnDevice === 0) {
    return report;
  }
  beginIndexBackupRun(mountPath);

  // Only the tracks the device actually took the value for. A track left out
  // here keeps `last_pushed_rating` unset and is retried on the next sync,
  // which is the whole repair mechanism for a write that could not happen.
  const pushed: number[] = [];

  for (const { trackId, idxId, rating } of writes) {
    try {
      recordOutcome(report, pushed, trackId, writeRating(mountPath, idxId, rating));
    } catch (err) {
      noteFailure(report, trackId, err);
    }
  }

  if (pushed.length > 0) markRatingsPropagated(db, deviceId, pushed);

  return report;
}

/**
 * What this module needs of a device. `Device` satisfies it structurally.
 */
export interface PropagationDeviceSource {
  fs: DeviceFs;
  mountPath: string;
  profile: { transport?: string };
}

/**
 * The right Phase 3 for this device — see the note on
 * `ingestRuntimeDataForDevice`, which chooses the same way and for the same
 * reason.
 */
export async function propagateRatingsForDevice(
  db: Database.Database,
  deviceId: number,
  device: PropagationDeviceSource,
  idxIds: Map<number, number>,
  selectedTrackIds: ReadonlySet<number>
): Promise<PropagationReport> {
  return device.profile.transport === "web"
    ? propagateRatingsToDeviceOn(
        db,
        deviceId,
        device.fs,
        device.mountPath,
        idxIds,
        selectedTrackIds
      )
    : propagateRatingsToDevice(
        db,
        deviceId,
        device.mountPath,
        idxIds,
        selectedTrackIds
      );
}

/**
 * {@link propagateRatingsToDevice} for a device reached through a `DeviceFs`.
 *
 * The writes are issued one at a time rather than in parallel, deliberately:
 * they all patch the same file, and Chrome's `createWritable()` rewrites it
 * wholesale rather than seeking, so two overlapping writes would lose one of
 * them in a file that carries no checksum.
 */
export async function propagateRatingsToDeviceOn(
  db: Database.Database,
  deviceId: number,
  deviceFs: DeviceFs,
  mountPath: string,
  idxIds: Map<number, number>,
  selectedTrackIds: ReadonlySet<number>
): Promise<PropagationReport> {
  const { writes, report } = planPropagation(db, deviceId, idxIds, selectedTrackIds);
  if (writes.length === 0 && report.notInDeviceDb === 0 && report.notOnDevice === 0) {
    return report;
  }
  beginIndexBackupRun(mountPath);

  const pushed: number[] = [];

  for (const { trackId, idxId, rating } of writes) {
    try {
      recordOutcome(
        report,
        pushed,
        trackId,
        await writeRatingOn(deviceFs, mountPath, idxId, rating)
      );
    } catch (err) {
      noteFailure(report, trackId, err);
    }
  }

  if (pushed.length > 0) markRatingsPropagated(db, deviceId, pushed);

  return report;
}
