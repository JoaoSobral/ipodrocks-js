/**
 * @vitest-environment node
 *
 * Issue #138: "A new album was synced without the ratings."
 *
 * `computeRatingPropagations()` joined `device_track_ratings` with an INNER
 * join, and the only two things that create a row in that table are the ingest
 * (which needs the *device* to have reported the track in its runtime data) and
 * `markRatingsPropagated` (which needs the track to already be in the
 * propagation set). A freshly copied track the device has never reported was
 * therefore invisible to Phase 3 — a closed loop with no way in.
 *
 * It bit hardest on exactly the reporter's path, because a rebuild verdict skips
 * the ingest whole, so the rows were not created on that sync either: his album
 * was copied, and nothing ever pushed its ratings.
 *
 * Every existing propagation test seeded a `device_track_ratings` row first, so
 * the inner join always had something to find. These drive
 * `propagateRatingsToDevice()` — the real Phase 3, which until this change was
 * inline in `ipc/sync.ts` and re-implemented by its own tests.
 *
 * Run: npm test -- rating-propagation-gap
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  canRunDbTests,
  cleanupTmp,
  closeDb,
  createTestDb,
  createTmpDir,
  seedDevice,
  seedLibraryFolder,
  seedTrack,
  writeTcdFixture,
  readTcdNumericTag,
  TCD_TAG,
  type TestDb,
} from "../harness";

import { resetBackupState } from "../../main/rockbox/tagcache-index";
import { readAndIngestRuntimeData } from "../../main/rockbox/runtime-ingest";
import {
  computeRatingPropagations,
  detectRebuiltDatabase,
  invalidatePushedRatings,
  markRatingsPropagated,
} from "../../main/sync/rating-merge";
import { propagateRatingsToDevice } from "../../main/sync/rating-propagate";
import { remapTrackMapToShadow } from "../../main/ipc/common";

const itDb = it.skipIf(!canRunDbTests);

describe("ratings reach a track the device has never reported (#138)", () => {
  let db: TestDb;
  let mount: string;
  let deviceId: number;
  let folderId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    mount = createTmpDir("rating-gap-");
    resetBackupState();
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/music",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: mount });
    selected = new Set();
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(mount);
  });

  /**
   * Library track ids this "sync" sent to the device — what `ipc/sync.ts` builds
   * from its own selection maps and hands to `propagateRatingsToDevice`.
   */
  let selected: Set<number>;

  /** A library track that is on the device, with a rating only iPodRocks knows. */
  function seedSyncedTrack(name: string, rating: number | null): number {
    const libraryPath = `/music/${name}.flac`;
    const id = seedTrack(db, {
      path: libraryPath,
      title: name,
      libraryFolderId: folderId,
      ...(rating != null && { rating }),
    });
    db.prepare(
      "INSERT INTO device_synced_tracks (device_id, library_path, device_path) VALUES (?, ?, ?)"
    ).run(deviceId, libraryPath, `Music/${name}.mpc`);
    selected.add(id);
    return id;
  }

  function pushedRating(trackId: number): number | null | undefined {
    const row = db
      .prepare(
        "SELECT last_pushed_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?"
      )
      .get(deviceId, trackId) as { last_pushed_rating: number | null } | undefined;
    return row === undefined ? undefined : row.last_pushed_rating;
  }

  itDb("a rated track with no device_track_ratings row is a propagation candidate", () => {
    // The bug in one assertion. Nothing has ever created a baseline row for
    // this track, which is the state of every track the sync has just copied.
    const id = seedSyncedTrack("Fresh", 8);
    expect(pushedRating(id)).toBeUndefined();

    expect(computeRatingPropagations(db, deviceId).get(id)).toBe(8);
  });

  itDb("a newly copied album's ratings are written on the first sync that sees it", () => {
    // The device's database now lists the files (the user updated it), but it
    // has never reported a rating for any of them — they read 0.
    const ids = ["A", "B", "C"].map((n) => seedSyncedTrack(n, 6));
    const idxIds = writeTcdFixture(
      mount,
      ids.map((_, i) => ({ path: `/<HDD0>/Music/${["A", "B", "C"][i]}.mpc` }))
    );

    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map(ids.map((id, i) => [id, idxIds[i]])),
      selected
    );

    expect(report.written).toBe(3);
    expect(report.notInDeviceDb).toBe(0);
    for (const [i, id] of ids.entries()) {
      expect(readTcdNumericTag(mount, idxIds[i], TCD_TAG.rating)).toBe(6);
      expect(pushedRating(id)).toBe(6);
    }
  });

  itDb("the reporter's sync: a rebuild skips the ingest, and the ratings still land", () => {
    // End to end on the path from issue #138. The device has recorded plays, so
    // its runtime data reads fine; what it has lost is every rating it was last
    // seen holding, because the user reinitialised its database. That is the
    // loss `detectRebuiltDatabase` measures, and on that verdict Phase 1 is
    // skipped whole — so nothing creates the baseline rows Phase 3 used to
    // depend on, for the old tracks or the newly copied album.
    const old = Array.from({ length: 6 }, (_, i) => seedSyncedTrack(`old${i}`, 7));
    const album = Array.from({ length: 3 }, (_, i) => seedSyncedTrack(`new${i}`, 9));

    // What the device told us last sync, before it was rebuilt.
    for (const id of old) {
      db.prepare(
        `INSERT INTO device_track_ratings
           (device_id, track_id, last_seen_rating, last_pushed_rating)
         VALUES (?, ?, 7, 7)`
      ).run(deviceId, id);
    }

    const fixture = [
      ...old.map((_, i) => ({
        path: `/<HDD0>/Music/old${i}.mpc`,
        playCount: 3,
        playTimeMs: 600_000,
        lastPlayedSerial: 10 + i,
      })),
      ...album.map((_, i) => ({ path: `/<HDD0>/Music/new${i}.mpc` })),
    ];
    const idxIds = writeTcdFixture(mount, fixture);

    const imported = readAndIngestRuntimeData(db, deviceId, mount, false);
    expect(imported.state.kind).toBe("ok");
    expect(imported.ratings.size).toBe(9);

    const verdict = detectRebuiltDatabase(
      db,
      deviceId,
      imported.ratings,
      imported.serial
    );
    expect(verdict.looksRebuilt).toBe(true);
    expect(verdict.cleared).toBe(6);

    // Phase 1's repair, then Phase 3. The old tracks were already pushed, so
    // only invalidating frees them; the album has no row at all, which is what
    // the inner join could never reach.
    invalidatePushedRatings(db, deviceId);
    const report = propagateRatingsToDevice(db, deviceId, mount, imported.idxIds, selected);

    expect(report.written).toBe(9);
    for (const [i, id] of old.entries()) {
      expect(readTcdNumericTag(mount, idxIds[i], TCD_TAG.rating)).toBe(7);
      expect(pushedRating(id)).toBe(7);
    }
    for (const [i, id] of album.entries()) {
      expect(readTcdNumericTag(mount, idxIds[old.length + i], TCD_TAG.rating)).toBe(9);
      expect(pushedRating(id)).toBe(9);
    }
  });

  itDb("a track missing from the device's database is reported, not marked", () => {
    // Copied this sync, so Rockbox's database does not list it yet. There is no
    // record to write into; the rating has to survive to the next sync.
    const onDevice = seedSyncedTrack("Known", 4);
    const justCopied = seedSyncedTrack("Unknown", 9);
    const idxIds = writeTcdFixture(mount, [{ path: "/<HDD0>/Music/Known.mpc" }]);

    const first = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([[onDevice, idxIds[0]]]),
      selected
    );

    expect(first.written).toBe(1);
    expect(first.notInDeviceDb).toBe(1);
    expect(pushedRating(justCopied)).toBeUndefined();

    // The user updates the database on the player; the next sync finds it.
    const bothIdx = writeTcdFixture(mount, [
      { path: "/<HDD0>/Music/Known.mpc", rating: 4 },
      { path: "/<HDD0>/Music/Unknown.mpc" },
    ]);
    const second = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([
        [onDevice, bothIdx[0]],
        [justCopied, bothIdx[1]],
      ]),
      selected
    );

    expect(second.written).toBe(1);
    expect(second.notInDeviceDb).toBe(0);
    expect(readTcdNumericTag(mount, bothIdx[1], TCD_TAG.rating)).toBe(9);
    expect(pushedRating(justCopied)).toBe(9);
  });

  itDb("a database Rockbox is updating is not recorded as pushed", () => {
    // `header.dirty != 0`. Marking these would have excluded them from every
    // later sync's propagation set — the rating would never arrive, with no
    // action the user could take.
    const id = seedSyncedTrack("Busy", 5);
    const idxIds = writeTcdFixture(mount, [{ path: "/<HDD0>/Music/Busy.mpc" }], {
      dirty: 1,
    });

    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([[id, idxIds[0]]]),
      selected
    );

    expect(report.unavailable).toBe(1);
    expect(report.written).toBe(0);
    expect(pushedRating(id)).toBeUndefined();
    expect(readTcdNumericTag(mount, idxIds[0], TCD_TAG.rating)).toBe(0);

    // Retried, and written, once Rockbox has finished.
    writeTcdFixture(mount, [{ path: "/<HDD0>/Music/Busy.mpc" }]);
    expect(
      propagateRatingsToDevice(db, deviceId, mount, new Map([[id, idxIds[0]]]), selected).written
    ).toBe(1);
    expect(pushedRating(id)).toBe(5);
  });

  itDb("a missing index is not recorded as pushed", () => {
    const id = seedSyncedTrack("NoDb", 3);
    const idxIds = writeTcdFixture(mount, [{ path: "/<HDD0>/Music/NoDb.mpc" }]);
    fs.rmSync(path.join(mount, ".rockbox", "database_idx.tcd"));

    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([[id, idxIds[0]]]),
      selected
    );

    expect(report.unavailable).toBe(1);
    expect(pushedRating(id)).toBeUndefined();
  });

  itDb("a track whose write throws does not discard the others", () => {
    // An out-of-range index id throws TcdFormatError. It used to escape the
    // loop, so `markRatingsPropagated` never ran and every rating written
    // before it was recorded as still unpushed — they would be rewritten every
    // sync forever, and anything after it never written at all.
    const good = seedSyncedTrack("Good", 8);
    const bad = seedSyncedTrack("Bad", 2);
    const alsoGood = seedSyncedTrack("AlsoGood", 10);
    const idxIds = writeTcdFixture(mount, [
      { path: "/<HDD0>/Music/Good.mpc" },
      { path: "/<HDD0>/Music/AlsoGood.mpc" },
    ]);

    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([
        [good, idxIds[0]],
        [bad, 999], // past header.entryCount
        [alsoGood, idxIds[1]],
      ]),
      selected
    );

    expect(report.failed).toBe(1);
    expect(report.written).toBe(2);
    expect(pushedRating(good)).toBe(8);
    expect(pushedRating(alsoGood)).toBe(10);
    expect(pushedRating(bad)).toBeUndefined();
  });

  itDb("already-correct ratings are marked without writing bytes", () => {
    const id = seedSyncedTrack("Same", 8);
    const idxIds = writeTcdFixture(mount, [
      { path: "/<HDD0>/Music/Same.mpc", rating: 8 },
    ]);

    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([[id, idxIds[0]]]),
      selected
    );

    expect(report.written).toBe(0);
    expect(report.alreadyCorrect).toBe(1);
    // Marked, or every sync would reconsider it forever.
    expect(pushedRating(id)).toBe(8);
  });

  itDb("a rated track that is not on this device is not reported as waiting", () => {
    // The cost of widening the join: `computeRatingPropagations` now offers every
    // rated track, so without a split a 20,000-track library syncing a 500-track
    // selection announced "19,500 rating(s) are waiting for the device's
    // database" on every sync. Only a track the sync recorded as *on* this device
    // is actionable.
    const onDevice = seedSyncedTrack("Here", 7);

    // Rated, but never synced to this device — no device_synced_tracks row.
    seedTrack(db, {
      path: "/music/Elsewhere.flac",
      title: "Elsewhere",
      libraryFolderId: folderId,
      rating: 9,
    });

    const idxIds = writeTcdFixture(mount, [{ path: "/<HDD0>/Music/Here.mpc" }]);
    const report = propagateRatingsToDevice(
      db,
      deviceId,
      mount,
      new Map([[onDevice, idxIds[0]]]),
      selected
    );

    expect(report.written).toBe(1);
    expect(report.notInDeviceDb).toBe(0);
    expect(report.notOnDevice).toBe(1);
  });

  itDb("a selected track the device has not indexed is the actionable count", () => {
    // The split's own guard: a track this sync sent here, that the device's
    // database does not list, is exactly what the "run Database → Update now"
    // message is for.
    const id = seedSyncedTrack("Copied", 5);

    const report = propagateRatingsToDevice(db, deviceId, mount, new Map(), selected);

    expect(report.notInDeviceDb).toBe(1);
    expect(report.notOnDevice).toBe(0);
    expect(pushedRating(id)).toBeUndefined();
  });

  itDb("widening the join does not push unrated tracks or contested ones", () => {
    // The guards the LEFT JOIN must not lose.
    const unrated = seedSyncedTrack("Unrated", null);
    const contested = seedSyncedTrack("Contested", 9);
    const settled = seedSyncedTrack("Settled", 6);

    db.prepare(
      `INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating)
       VALUES (?, ?, 2, 9, 9)`
    ).run(contested, deviceId);
    markRatingsPropagated(db, deviceId, [settled]);

    const props = computeRatingPropagations(db, deviceId);

    expect(props.has(unrated)).toBe(false);
    expect(props.has(contested)).toBe(false);
    expect(props.has(settled)).toBe(false);
  });
});

describe("the sync selection a shadow-backed device propagates against", () => {
  it("keeps the library track id through the shadow remap", () => {
    // `ipc/sync.ts` builds the selection set from these maps *after* the shadow
    // remap, and reads `info.id` from each record. On a shadow-backed device the
    // map is re-keyed by the transcode's path — if the remap dropped or rewrote
    // `id`, every rating waiting on such a device's database would be filed as
    // "not on this device" and the user would never be told to update it.
    const remapped = remapTrackMapToShadow(
      {
        "/music/a.flac": { id: 7, path: "/music/a.flac", title: "A" },
        "/music/b.flac": { id: 8, path: "/music/b.flac", title: "B" },
      },
      new Map([[7, "/shadow/a.mpc"]])
    );

    expect(Object.keys(remapped)).toEqual(["/shadow/a.mpc"]);
    expect(remapped["/shadow/a.mpc"].id).toBe(7);
    expect(remapped["/shadow/a.mpc"].path).toBe("/shadow/a.mpc");
  });
});
