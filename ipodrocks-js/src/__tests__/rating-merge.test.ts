/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";
import {
  detectDeviceChanges,
  mergeRating,
  loadDeviceManifest,
  ingestDeviceRatings,
  computeRatingPropagations,
  markRatingsPropagated,
} from "../main/sync/rating-merge";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node */
}

// ---------------------------------------------------------------------------
// Pure logic — no DB needed
// ---------------------------------------------------------------------------

describe("detectDeviceChanges", () => {
  it("returns first_observation for a track not in the manifest", () => {
    const current = new Map([[1, 8]]);
    const manifest = new Map<number, number>();
    const result = detectDeviceChanges(current, manifest);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ trackId: 1, baseline: null, current: 8, kind: "first_observation" });
  });

  it("returns device_edit when rating changed from baseline", () => {
    const current = new Map([[1, 8]]);
    const manifest = new Map([[1, 6]]);
    const result = detectDeviceChanges(current, manifest);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ trackId: 1, baseline: 6, current: 8, kind: "device_edit" });
  });

  it("omits track when rating is unchanged from baseline", () => {
    const current = new Map([[1, 6]]);
    const manifest = new Map([[1, 6]]);
    expect(detectDeviceChanges(current, manifest)).toHaveLength(0);
  });

  it("handles multiple tracks with mixed outcomes", () => {
    const current = new Map([[1, 8], [2, 4], [3, 6]]);
    const manifest = new Map([[2, 4], [3, 2]]);
    const result = detectDeviceChanges(current, manifest);
    expect(result).toHaveLength(2);
    const kinds = new Set(result.map((r) => r.kind));
    expect(kinds.has("first_observation")).toBe(true); // track 1
    expect(kinds.has("device_edit")).toBe(true);       // track 3
  });
});

describe("mergeRating", () => {
  // baseline=null (first observation)
  it("adopt_device when library is unrated on first observation", () => {
    expect(mergeRating(null, 8, null, null, 0, 0)).toEqual({ action: "adopt_device", value: 8 });
  });

  it("converged when device matches library on first observation", () => {
    expect(mergeRating(null, 8, 8, null, 0, 0)).toEqual({ action: "converged", value: 8 });
  });

  it("conflict when device disagrees with existing library on first observation", () => {
    expect(mergeRating(null, 8, 6, null, 0, 0)).toEqual({ action: "conflict", canonical: 6, deviceProposed: 8 });
  });

  // Both unchanged
  it("noop when neither side changed", () => {
    expect(mergeRating(6, 6, 6, 6, 0, 0)).toEqual({ action: "noop", value: 6 });
  });

  // Only device changed
  it("adopt_device when only device changed", () => {
    expect(mergeRating(6, 8, 6, 6, 0, 0)).toEqual({ action: "adopt_device", value: 8 });
  });

  // Only library changed
  it("propagate_lib when only library changed", () => {
    expect(mergeRating(6, 6, 8, 6, 0, 1)).toEqual({ action: "propagate_lib", value: 8 });
  });

  // Both changed, same result
  it("converged when both changed to same value", () => {
    expect(mergeRating(6, 8, 8, 6, 0, 1)).toEqual({ action: "converged", value: 8 });
  });

  // Half-step tolerance (|device - library| <= 1)
  it("converged via half-step tolerance and takes max when diff is 1", () => {
    // device: 7, library: 8 — diff = 1, take max = 8
    const result = mergeRating(6, 7, 8, 6, 0, 1);
    expect(result).toEqual({ action: "converged", value: 8 });
  });

  it("conflict when both changed and diff exceeds 1", () => {
    // device: 4, library: 8 — diff = 4
    const result = mergeRating(6, 4, 8, 6, 0, 1);
    expect(result).toEqual({ action: "conflict", canonical: 8, deviceProposed: 4 });
  });
});

// ---------------------------------------------------------------------------
// DB-backed tests
// ---------------------------------------------------------------------------

describe("ingestDeviceRatings / computeRatingPropagations / markRatingsPropagated", () => {
  let db: import("better-sqlite3").Database;

  function setupDb() {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    db.pragma("foreign_keys = OFF"); // avoid needing all referenced tables
    db.exec(SCHEMA_SQL);
    // Seed: one device, one track
    db.prepare("INSERT INTO devices (id, name, mount_path, music_folder, podcast_folder, audiobook_folder, playlist_folder, default_transfer_mode_id) VALUES (1, 'iPod', '/mnt/ipod', 'Music', 'Podcasts', 'Audiobooks', 'Playlists', 1)").run();
    db.prepare("INSERT INTO tracks (id, path, filename, title, content_type, rating, rating_version) VALUES (1, '/lib/track.mp3', 'track.mp3', 'Test Track', 'music', NULL, 0)").run();
  }

  beforeEach(() => {
    if (canRunDbTests) setupDb();
  });

  afterEach(() => {
    if (canRunDbTests && db) db.close();
  });

  it.skipIf(!canRunDbTests)("loadDeviceManifest returns empty map when no baseline exists", () => {
    const manifest = loadDeviceManifest(db, 1);
    expect(manifest.size).toBe(0);
  });

  it.skipIf(!canRunDbTests)("ingestDeviceRatings adopts device rating when library is unrated", () => {
    const result = ingestDeviceRatings(db, 1, new Map([[1, 8]]));
    expect(result.adopted).toBe(1);
    expect(result.conflicts).toBe(0);
    const track = db.prepare("SELECT rating FROM tracks WHERE id = 1").get() as { rating: number };
    expect(track.rating).toBe(8);
  });

  it.skipIf(!canRunDbTests)("ingestDeviceRatings records a conflict when device and library diverge significantly", () => {
    // Set library rating first
    db.prepare("UPDATE tracks SET rating = 6, rating_version = 1 WHERE id = 1").run();
    // Device reports 2 — diff > 1 → conflict
    const result = ingestDeviceRatings(db, 1, new Map([[1, 2]]));
    expect(result.conflicts).toBe(1);
    const conflicts = db.prepare("SELECT * FROM rating_conflicts WHERE resolved_at IS NULL").all();
    expect(conflicts).toHaveLength(1);
  });

  it.skipIf(!canRunDbTests)("ingestDeviceRatings converges via half-step tolerance", () => {
    db.prepare("UPDATE tracks SET rating = 6, rating_version = 1 WHERE id = 1").run();
    // Seed baseline so merge sees both sides changed
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating) VALUES (1, 1, 4)").run();
    // Device reports 7, library is 8 — diff = 1 → converged
    const result = ingestDeviceRatings(db, 1, new Map([[1, 7]]));
    expect(result.converged).toBe(1);
    expect(result.conflicts).toBe(0);
  });

  it.skipIf(!canRunDbTests)("ingestDeviceRatings returns noop when rating is unchanged", () => {
    db.prepare("UPDATE tracks SET rating = 6, rating_version = 1 WHERE id = 1").run();
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating) VALUES (1, 1, 6)").run();
    const result = ingestDeviceRatings(db, 1, new Map([[1, 6]]));
    expect(result.noop).toBe(1);
  });

  it.skipIf(!canRunDbTests)("computeRatingPropagations returns tracks needing propagation", () => {
    db.prepare("UPDATE tracks SET rating = 8, rating_version = 1 WHERE id = 1").run();
    // Insert baseline with different last_pushed_rating
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating) VALUES (1, 1, 8, 6)").run();
    const propagations = computeRatingPropagations(db, 1);
    expect(propagations.has(1)).toBe(true);
    expect(propagations.get(1)).toBe(8);
  });

  it.skipIf(!canRunDbTests)("computeRatingPropagations excludes tracks with unresolved conflicts", () => {
    db.prepare("UPDATE tracks SET rating = 8, rating_version = 1 WHERE id = 1").run();
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating) VALUES (1, 1, 8, 6)").run();
    db.prepare("INSERT INTO rating_conflicts (track_id, device_id, reported_rating, baseline_rating, canonical_rating) VALUES (1, 1, 2, 6, 8)").run();
    const propagations = computeRatingPropagations(db, 1);
    expect(propagations.has(1)).toBe(false);
  });

  it.skipIf(!canRunDbTests)("markRatingsPropagated updates last_pushed_rating", () => {
    db.prepare("UPDATE tracks SET rating = 8, rating_version = 1 WHERE id = 1").run();
    db.prepare("INSERT INTO device_track_ratings (device_id, track_id, last_seen_rating, last_pushed_rating) VALUES (1, 1, 8, 6)").run();
    markRatingsPropagated(db, 1, [1]);
    const row = db.prepare("SELECT last_pushed_rating FROM device_track_ratings WHERE device_id = 1 AND track_id = 1").get() as { last_pushed_rating: number };
    expect(row.last_pushed_rating).toBe(8);
  });

  it.skipIf(!canRunDbTests)("massZeroFraction detects suspected DB rebuild", () => {
    // 5 tracks, 4 rated 0 → fraction = 0.8
    for (let i = 2; i <= 5; i++) {
      db.prepare(`INSERT INTO tracks (id, path, filename, title, content_type, rating, rating_version) VALUES (${i}, '/lib/track${i}.mp3', 'track${i}.mp3', 'Track ${i}', 'music', NULL, 0)`).run();
    }
    const ratings = new Map([[1, 0], [2, 0], [3, 0], [4, 0], [5, 6]]);
    const result = ingestDeviceRatings(db, 1, ratings);
    expect(result.massZeroFraction).toBeCloseTo(0.8);
  });
});
