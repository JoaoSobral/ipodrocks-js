/**
 * @vitest-environment node
 *
 * Regression — issue #117 follow-up: what Rockbox's rating of 0 means, and what
 * a rebuilt device database actually looks like.
 *
 * Once the path matching was fixed the reporter's iPod started matching all
 * 2411 of its runtime records, and two faults that had been unreachable while
 * nothing matched came straight out:
 *
 *  1. Rockbox has no null rating — 0 is how it says "unrated" — but the merge
 *     read it as the value zero. A first sync therefore queued one conflict for
 *     every track the user had rated in iPodRocks and not on the player, and
 *     wrote a rating of 0 over every unrated track in the library.
 *  2. The rebuild check asked what share of the device's ratings read 0, which
 *     is not a rebuild signal but a description of a normal library: 43 rated
 *     tracks out of 2411 scored 0.98 and tripped the warning every sync. It
 *     also ran *after* the merge, so "ratings were skipped" described nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedDevice,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";

import {
  detectRebuiltDatabase,
  ingestDeviceRatings,
  computeRatingPropagations,
  markRatingsPropagated,
  invalidatePushedRatings,
} from "../../main/sync/rating-merge";

const itDb = it.skipIf(!canRunDbTests);

describe("a Rockbox rating of 0 is 'unrated', not the value zero", () => {
  let db: TestDb;
  let deviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "M", path: "/m", contentType: "music" });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt" });
  });

  afterEach(() => closeDb(db));

  function track(name: string, rating?: number): number {
    const id = seedTrack(db, { path: `/m/${name}.flac`, libraryFolderId: folderId });
    if (rating != null) {
      db.prepare("UPDATE tracks SET rating = ? WHERE id = ?").run(rating, id);
    }
    return id;
  }

  const ratingOf = (id: number): number | null =>
    (db.prepare("SELECT rating FROM tracks WHERE id = ?").get(id) as {
      rating: number | null;
    }).rating;

  const openConflicts = (): number =>
    (db
      .prepare("SELECT COUNT(*) AS c FROM rating_conflicts WHERE resolved_at IS NULL")
      .get() as { c: number }).c;

  itDb("does not queue a conflict for a track the device has no rating for", () => {
    // The reporter's case: rated in iPodRocks, never rated on the iPod.
    const id = track("rated-in-library", 10);

    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    expect(openConflicts()).toBe(0);
    expect(res.conflicts).toBe(0);
    // The library keeps its rating, and Phase 3 will push it to the device.
    expect(ratingOf(id)).toBe(10);
    expect(res.propagated).toBe(1);
  });

  itDb("does not write a rating of 0 over an unrated library track", () => {
    const id = track("unrated-everywhere");

    ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    // Unrated must stay unrated. Writing 0 turned "no rating" into "rated zero
    // stars" across the whole library on the first sync.
    expect(ratingOf(id)).toBeNull();
  });

  itDb("still records the reading as the baseline for next time", () => {
    // The 0 is not adopted, but it is what the device said — the next import
    // has to be able to tell a new rating from an unchanged one.
    const id = track("unrated-everywhere");

    ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));
    expect(
      (db
        .prepare(
          "SELECT last_seen_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?"
        )
        .get(deviceId, id) as { last_seen_rating: number }).last_seen_rating
    ).toBe(0);

    // Rated on the device afterwards: now there is something to adopt.
    const second = ingestDeviceRatings(db, deviceId, new Map([[id, 6]]));
    expect(second.adopted).toBe(1);
    expect(ratingOf(id)).toBe(6);
  });

  itDb("does not write 0 over an unrated library track that has a baseline", () => {
    // Same rule as the first-observation case, but with a baseline on record —
    // the state a track lands in as soon as the library's rating is cleared.
    // "Device changed, library unchanged" used to adopt the 0 outright.
    const id = track("cleared-in-library");
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating, last_seen_at)
       VALUES (?, ?, 8, 8, CURRENT_TIMESTAMP)`
    ).run(deviceId, id);

    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    expect(ratingOf(id)).toBeNull();
    expect(res.adopted).toBe(0);
    expect(openConflicts()).toBe(0);
  });

  itDb("does not queue a conflict between a device 0 and no library rating", () => {
    // There is no question to put to the user here: "keep 0" and "keep
    // nothing" are the same answer, and the conflict row's canonical_rating is
    // null so the UI has nothing to offer against the device's 0. Reachable as
    // soon as a repaired device was read back (issue #117 follow-up).
    const id = track("cleared-in-library");
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating, last_seen_at)
       VALUES (?, ?, 8, 8, CURRENT_TIMESTAMP)`
    ).run(deviceId, id);
    // Make the library side look changed too, which is what forced the
    // divergent branch: rating_version has moved since the last sync.
    db.prepare("UPDATE tracks SET rating_version = 3 WHERE id = ?").run(id);

    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    expect(res.conflicts).toBe(0);
    expect(openConflicts()).toBe(0);
    expect(ratingOf(id)).toBeNull();
  });

  itDb("heals the stranded baseline so it cannot come back", () => {
    // The baseline is what made the device's 0 look like a disagreement. Once
    // the ingest has seen the device read 0, it records that, and the track is
    // ordinary again.
    const id = track("cleared-in-library");
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating, last_seen_at)
       VALUES (?, ?, 8, 8, CURRENT_TIMESTAMP)`
    ).run(deviceId, id);

    ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    expect(
      (db
        .prepare(
          "SELECT last_seen_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?"
        )
        .get(deviceId, id) as { last_seen_rating: number }).last_seen_rating
    ).toBe(0);
  });

  itDb("still adopts a device clearing a rating the library does hold", () => {
    // The guard is only about a *null* library rating. A device that clears a
    // rating iPodRocks still holds is a real edit and must go on working.
    const id = track("cleared-on-device", 8);
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating, last_seen_at)
       VALUES (?, ?, 8, 8, CURRENT_TIMESTAMP)`
    ).run(deviceId, id);

    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 0]]));

    expect(res.adopted).toBe(1);
    expect(ratingOf(id)).toBe(0);
  });

  itDb("still adopts a real rating from a device seen for the first time", () => {
    const id = track("rated-on-device-only");
    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 8]]));
    expect(res.adopted).toBe(1);
    expect(ratingOf(id)).toBe(8);
  });

  itDb("still raises a genuine disagreement as a conflict", () => {
    // Both sides rated, and they differ by more than the half-step tolerance.
    // Narrowing what counts as a conflict must not silence the real ones.
    const id = track("disputed", 10);
    const res = ingestDeviceRatings(db, deviceId, new Map([[id, 2]]));
    expect(res.conflicts).toBe(1);
    expect(openConflicts()).toBe(1);
    // Canonical is untouched until the user answers.
    expect(ratingOf(id)).toBe(10);
  });

  itDb("a first sync of the reporter's library raises nothing to answer", () => {
    // 2411 tracks on the device, 43 rated there; 100 rated in iPodRocks only.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const id = track(`t${i}`, i >= 100 && i < 200 ? 10 : undefined);
      ratings.set(id, i < 43 ? 8 : 0);
    }

    const res = ingestDeviceRatings(db, deviceId, ratings);

    expect(openConflicts()).toBe(0);
    expect(res.adopted).toBe(43);
    // Every library rating survives, and every unrated track stays unrated.
    expect(
      (db
        .prepare("SELECT COUNT(*) AS c FROM tracks WHERE rating IS NOT NULL")
        .get() as { c: number }).c
    ).toBe(143);
  });
});

describe("deciding whether a device's database was rebuilt", () => {
  let db: TestDb;
  let deviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "M", path: "/m", contentType: "music" });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt" });
  });

  afterEach(() => closeDb(db));

  /**
   * A track this device was last seen holding `seen` for, which the library
   * also rates (`libRating`, defaulting to the same value).
   *
   * The library side matters: only a track the library still rates counts
   * towards the verdict, because only such a track can be lost or repaired.
   * That is also the realistic shape — an ingest that adopts a device rating
   * writes `tracks.rating` at the same time it writes the baseline.
   */
  function seen(name: string, lastSeen: number, libRating: number | null = lastSeen): number {
    const id = seedTrack(db, { path: `/m/${name}.flac`, libraryFolderId: folderId });
    if (libRating !== null) {
      db.prepare("UPDATE tracks SET rating = ? WHERE id = ?").run(libRating, id);
    }
    db.prepare(
      `INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_seen_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(deviceId, id, lastSeen);
    return id;
  }

  itDb("a mostly-unrated library is not a rebuild", () => {
    // The exact shape that tripped the old check on every single sync: almost
    // everything reads 0 because almost nothing was ever rated.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 2411; i++) {
      const id = seedTrack(db, { path: `/m/t${i}.flac`, libraryFolderId: folderId });
      ratings.set(id, i < 43 ? 8 : 0);
    }

    const res = detectRebuiltDatabase(db, deviceId, ratings, 446);
    expect(res.looksRebuilt).toBe(false);
    expect(res.reason).toBeNull();
  });

  itDb("ratings this device is known to have held, now all gone, is a rebuild", () => {
    const ratings = new Map<number, number>();
    for (let i = 0; i < 20; i++) ratings.set(seen(`r${i}`, 8), 0);
    // Plus a lot of tracks that were never rated either way — noise the old
    // check counted and this one must not.
    for (let i = 0; i < 500; i++) {
      ratings.set(seedTrack(db, { path: `/m/u${i}.flac`, libraryFolderId: folderId }), 0);
    }

    const res = detectRebuiltDatabase(db, deviceId, ratings, 446);
    expect(res.looksRebuilt).toBe(true);
    expect(res.previouslyRated).toBe(20);
    expect(res.cleared).toBe(20);
    expect(res.reason).toMatch(/20 of the 20/);
  });

  itDb("a few ratings cleared by hand is editing, not a wipe", () => {
    const ratings = new Map<number, number>();
    for (let i = 0; i < 20; i++) ratings.set(seen(`r${i}`, 8), i < 3 ? 0 : 8);

    const res = detectRebuiltDatabase(db, deviceId, ratings, 446);
    expect(res.looksRebuilt).toBe(false);
    expect(res.cleared).toBe(3);
  });

  itDb("too few rated tracks to judge is not a verdict", () => {
    // Clearing the only two ratings on the device must not be called a rebuild.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 2; i++) ratings.set(seen(`r${i}`, 8), 0);

    expect(detectRebuiltDatabase(db, deviceId, ratings, 446).looksRebuilt).toBe(false);
  });

  itDb("a rating the user cleared in the library is not evidence of a rebuild", () => {
    // `last_seen_rating` says what the device reported and is never rewritten
    // when the library's own rating changes, so un-rating a track in the
    // library leaves a baseline above zero pointing at a null canonical.
    // The device honestly still reads 0 for it, on this sync and every later
    // one — Rockbox has no null to push "unrated" out with — so counting it as
    // loss made the warning permanent with no action that could clear it.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 20; i++) ratings.set(seen(`r${i}`, 8, null), 0);

    const res = detectRebuiltDatabase(db, deviceId, ratings, 446);
    expect(res.looksRebuilt).toBe(false);
    expect(res.previouslyRated).toBe(0);
    expect(res.reason).toBeNull();
  });

  itDb("counts a canonical 0 as un-rated too, not as something to restore", () => {
    // Rockbox has no null: pushing a canonical 0 would change nothing on the
    // device, so `rating > 0` is the test, not `IS NOT NULL`.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 20; i++) ratings.set(seen(`r${i}`, 8, 0), 0);

    expect(detectRebuiltDatabase(db, deviceId, ratings, 446).previouslyRated).toBe(0);
  });

  itDb("still catches a real rebuild among tracks the library un-rated", () => {
    // Narrowing the sample must not blind the check: the tracks the library
    // still rates are exactly the ones a rebuild can destroy, and they are the
    // ones counted.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 20; i++) ratings.set(seen(`cleared${i}`, 8, null), 0);
    for (let i = 0; i < 8; i++) ratings.set(seen(`lost${i}`, 8), 0);

    const res = detectRebuiltDatabase(db, deviceId, ratings, 446);
    expect(res.looksRebuilt).toBe(true);
    expect(res.previouslyRated).toBe(8);
    expect(res.cleared).toBe(8);
    expect(res.reason).toMatch(/8 of the 8/);
  });

  itDb("the verdict clears once the repaired ratings read back from the device", () => {
    // The loop the reporter was stuck in, end to end: a rebuild is called, the
    // repair re-pushes the library's ratings in that same sync, and the next
    // sync — reading those values back — must not call it a rebuild again.
    const ids = Array.from({ length: 10 }, (_, i) => seen(`r${i}`, 8));
    markRatingsPropagated(db, deviceId, ids);

    const wiped = new Map(ids.map((id) => [id, 0]));
    expect(detectRebuiltDatabase(db, deviceId, wiped, 446).looksRebuilt).toBe(true);

    // Phase 1's repair, then Phase 3 re-sending every rating it freed up.
    invalidatePushedRatings(db, deviceId);
    const props = computeRatingPropagations(db, deviceId);
    expect(props.size).toBe(10);
    markRatingsPropagated(db, deviceId, [...props.keys()]);

    // Next sync: the device reads back what was written to it.
    const repaired = new Map(ids.map((id) => [id, 8]));
    const res = detectRebuiltDatabase(db, deviceId, repaired, 447);
    expect(res.looksRebuilt).toBe(false);
    expect(res.cleared).toBe(0);
  });

  itDb("a reset play counter with no ratings left is a rebuild", () => {
    // Rockbox's own signal, and the only one available before any baseline
    // exists — a rebuild resets master_header.serial to 0.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 30; i++) {
      ratings.set(seedTrack(db, { path: `/m/t${i}.flac`, libraryFolderId: folderId }), 0);
    }

    const res = detectRebuiltDatabase(db, deviceId, ratings, 0);
    expect(res.looksRebuilt).toBe(true);
    expect(res.reason).toMatch(/play counter/);
  });

  itDb("a reset play counter with ratings intact is not a loss", () => {
    // Rockbox flags records whose statistics survived a rebuild RESURRECTED.
    // Nothing was lost, so nothing may be blocked.
    const ratings = new Map<number, number>();
    for (let i = 0; i < 30; i++) {
      ratings.set(
        seedTrack(db, { path: `/m/t${i}.flac`, libraryFolderId: folderId }),
        i < 5 ? 9 : 0
      );
    }

    expect(detectRebuiltDatabase(db, deviceId, ratings, 0).looksRebuilt).toBe(false);
  });
});

describe("repairing a device after a rebuild is detected (issue #117 follow-up)", () => {
  let db: TestDb;
  let deviceId: number;
  let otherDeviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, { name: "M", path: "/m", contentType: "music" });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt" });
    otherDeviceId = seedDevice(db, { name: "iPod 2", mountPath: "/mnt2" });
  });

  afterEach(() => closeDb(db));

  function pushedRatingFor(device: number, trackId: number): number | null {
    return (
      db
        .prepare(
          "SELECT last_pushed_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?"
        )
        .get(device, trackId) as { last_pushed_rating: number | null }
    ).last_pushed_rating;
  }

  itDb("clears last_pushed_rating for this device only", () => {
    const id = seedTrack(db, { path: "/m/a.flac", libraryFolderId: folderId, rating: 8 });
    markRatingsPropagated(db, deviceId, [id]);
    markRatingsPropagated(db, otherDeviceId, [id]);

    const res = invalidatePushedRatings(db, deviceId);

    expect(res.invalidated).toBe(1);
    expect(pushedRatingFor(deviceId, id)).toBeNull();
    expect(pushedRatingFor(otherDeviceId, id)).toBe(8); // untouched
  });

  itDb("makes an already-pushed rating eligible for re-propagation again", () => {
    // The exact deadlock: pushed before the rebuild, so last_pushed_rating
    // already equals tracks.rating, so computeRatingPropagations excludes it.
    const id = seedTrack(db, { path: "/m/a.flac", libraryFolderId: folderId, rating: 8 });
    markRatingsPropagated(db, deviceId, [id]);
    expect(computeRatingPropagations(db, deviceId).size).toBe(0);

    invalidatePushedRatings(db, deviceId);

    const props = computeRatingPropagations(db, deviceId);
    expect(props.get(id)).toBe(8);
  });

  itDb("closes this device's open conflicts as canonical_wins, leaves others alone", () => {
    const id = seedTrack(db, { path: "/m/a.flac", libraryFolderId: folderId, rating: 8 });
    const otherId = seedTrack(db, { path: "/m/b.flac", libraryFolderId: folderId, rating: 5 });
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
       VALUES (?, ?, 2, 8, 8)`
    ).run(id, deviceId);
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
       VALUES (?, ?, 2, 5, 5)`
    ).run(otherId, otherDeviceId);

    const res = invalidatePushedRatings(db, deviceId);

    expect(res.conflictsResolved).toBe(1);
    const resolved = db
      .prepare("SELECT resolved_at, resolution FROM rating_conflicts WHERE track_id = ? AND device_id = ?")
      .get(id, deviceId) as { resolved_at: string | null; resolution: string | null };
    expect(resolved.resolved_at).not.toBeNull();
    expect(resolved.resolution).toBe("canonical_wins");

    const untouched = db
      .prepare("SELECT resolved_at FROM rating_conflicts WHERE track_id = ? AND device_id = ?")
      .get(otherId, otherDeviceId) as { resolved_at: string | null };
    expect(untouched.resolved_at).toBeNull();
  });

  itDb("does not touch an already-resolved conflict's resolution", () => {
    const id = seedTrack(db, { path: "/m/a.flac", libraryFolderId: folderId, rating: 8 });
    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating, resolved_at, resolution)
       VALUES (?, ?, 2, 8, 8, CURRENT_TIMESTAMP, 'device_wins')`
    ).run(id, deviceId);

    const res = invalidatePushedRatings(db, deviceId);

    expect(res.conflictsResolved).toBe(0);
    const row = db
      .prepare("SELECT resolution FROM rating_conflicts WHERE track_id = ?")
      .get(id) as { resolution: string };
    expect(row.resolution).toBe("device_wins");
  });
});
