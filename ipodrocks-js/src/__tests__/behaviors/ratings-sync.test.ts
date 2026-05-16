/**
 * @vitest-environment node
 *
 * Behavioral journey for the bidirectional rating sync — a device reports
 * track ratings, they merge into the library, and divergent edits are queued
 * as conflicts instead of silently overwriting.
 *
 * Drives `ingestDeviceRatings` (the same function the sync flow uses).
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

import { ingestDeviceRatings } from "../../main/sync/rating-merge";

const itDb = it.skipIf(!canRunDbTests);

describe("Ratings — device → library sync", () => {
  let db: TestDb;
  let deviceId: number;
  let trackIds: number[];

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    const folder = seedLibraryFolder(db, { name: "Music", path: "/music", contentType: "music" });
    trackIds = [
      seedTrack(db, { path: "/music/a.flac", title: "A", artist: "X", album: "Alb", libraryFolderId: folder }),
      seedTrack(db, { path: "/music/b.flac", title: "B", artist: "X", album: "Alb", libraryFolderId: folder, rating: 6 }),
      seedTrack(db, { path: "/music/c.flac", title: "C", artist: "X", album: "Alb", libraryFolderId: folder, rating: 8 }),
    ];
    deviceId = seedDevice(db, { name: "TestDevice", mountPath: "/mnt/device" });
  });

  afterEach(() => {
    closeDb(db);
  });

  itDb("adopts a device-set rating when the library is unrated", () => {
    const result = ingestDeviceRatings(
      db,
      deviceId,
      new Map([[trackIds[0], 7]])
    );

    expect(result.adopted).toBe(1);
    expect(result.conflicts).toBe(0);

    const updated = db
      .prepare("SELECT rating FROM tracks WHERE id = ?")
      .get(trackIds[0]) as { rating: number };
    expect(updated.rating).toBe(7);
  });

  itDb("converges when device and library agree", () => {
    const result = ingestDeviceRatings(
      db,
      deviceId,
      new Map([[trackIds[1], 6]])
    );

    expect(result.converged).toBe(1);
    expect(result.conflicts).toBe(0);

    const updated = db.prepare("SELECT rating FROM tracks WHERE id = ?").get(trackIds[1]) as { rating: number };
    expect(updated.rating).toBe(6);
  });

  itDb("queues a conflict when the library has its own rating and the device differs", () => {
    const result = ingestDeviceRatings(
      db,
      deviceId,
      new Map([[trackIds[2], 4]])
    );

    expect(result.conflicts).toBe(1);
    expect(result.adopted).toBe(0);

    const lib = db.prepare("SELECT rating FROM tracks WHERE id = ?").get(trackIds[2]) as { rating: number };
    expect(lib.rating).toBe(8);

    const conflict = db
      .prepare("SELECT reported_rating, canonical_rating FROM rating_conflicts WHERE track_id = ?")
      .get(trackIds[2]) as { reported_rating: number; canonical_rating: number };
    expect(conflict.reported_rating).toBe(4);
    expect(conflict.canonical_rating).toBe(8);
  });

  itDb("tolerates a half-step difference when both sides edited since last sync", () => {
    // Seed a known baseline so the merge sees both library and device as "changed".
    db.prepare(
      "INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating, last_seen_at, last_pushed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    ).run(deviceId, trackIds[1], 5, 5);
    db.prepare("UPDATE tracks SET rating = 6 WHERE id = ?").run(trackIds[1]);

    const result = ingestDeviceRatings(db, deviceId, new Map([[trackIds[1], 7]]));

    expect(result.conflicts).toBe(0);
    expect(result.converged).toBe(1);
    const lib = db.prepare("SELECT rating FROM tracks WHERE id = ?").get(trackIds[1]) as { rating: number };
    expect(lib.rating).toBe(7);
  });

  itDb("records last_seen baseline so the next ingestion sees a known state", () => {
    ingestDeviceRatings(db, deviceId, new Map([[trackIds[0], 9]]));

    const dtr = db
      .prepare("SELECT last_seen_rating FROM device_track_ratings WHERE device_id = ? AND track_id = ?")
      .get(deviceId, trackIds[0]) as { last_seen_rating: number };
    expect(dtr.last_seen_rating).toBe(9);

    const followup = ingestDeviceRatings(db, deviceId, new Map([[trackIds[0], 9]]));
    expect(followup.adopted).toBe(0);
    expect(followup.conflicts).toBe(0);
    expect(followup.noop).toBe(0);
  });
});
