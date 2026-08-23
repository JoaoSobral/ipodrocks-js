/**
 * @vitest-environment node
 *
 * Regression — issue #117: a device fed by a shadow library could not match a
 * single one of Rockbox's runtime records.
 *
 * `device_synced_tracks.library_path` records the file the sync copied *from*.
 * For a shadow-backed device that is the transcode inside the shadow library,
 * not the library track — so the exact tier's `JOIN tracks ON t.path =
 * dst.library_path` matched nothing at all, and the tier that is supposed to be
 * the reliable one contributed zero rows on precisely the configuration where
 * the inexact tiers also fail (a shadow library exists to hold a *different*
 * codec, so the device's filenames never carry the library's extension).
 *
 * The tag, mirror and basename tiers can all mask this, so the names here are
 * deliberately unrelated to the library's: nothing but the shadow join can
 * answer, and a pass therefore means the join is doing it.
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

import { buildDevicePathResolver } from "../../main/rockbox/device-path-match";

const itDb = it.skipIf(!canRunDbTests);

describe("matching Rockbox runtime records on a shadow-backed device", () => {
  let db: TestDb;
  let deviceId: number;
  let folderId: number;
  let shadowLibId: number;

  beforeEach(() => {
    if (!canRunDbTests) return;
    db = createTestDb();
    folderId = seedLibraryFolder(db, {
      name: "Music",
      path: "/library",
      contentType: "music",
    });
    deviceId = seedDevice(db, { name: "iPod", mountPath: "/mnt/ipod" });

    const codecConfig = db
      .prepare("SELECT id FROM codec_configurations LIMIT 1")
      .get() as { id: number };
    shadowLibId = Number(
      db
        .prepare(
          `INSERT INTO shadow_libraries (name, path, codec_config_id, status)
           VALUES ('Musepack', '/shadow', ?, 'ready')`
        )
        .run(codecConfig.id).lastInsertRowid
    );
  });

  afterEach(() => closeDb(db));

  /**
   * A library track, its shadow transcode, and the device_synced_tracks row a
   * device check writes for it — which points at the shadow file.
   *
   * `libraryName` and `deviceName` are unrelated on purpose. The track is left
   * untagged too, so its artist and album are the "Unknown" placeholders the
   * tag tier refuses to key on. Nothing is left that could bridge the two names
   * except the recorded device path.
   */
  function seedShadowSynced(libraryName: string, deviceName: string): number {
    const libraryPath = `/library/${libraryName}.flac`;
    const shadowPath = `/shadow/${libraryName}.mpc`;
    const trackId = seedTrack(db, {
      path: libraryPath,
      libraryFolderId: folderId,
    });
    db.prepare(
      `INSERT INTO shadow_tracks (shadow_library_id, source_track_id, shadow_path, status)
       VALUES (?, ?, ?, 'synced')`
    ).run(shadowLibId, trackId, shadowPath);
    db.prepare(
      `INSERT INTO device_synced_tracks (device_id, library_path, device_path)
       VALUES (?, ?, ?)`
    ).run(deviceId, shadowPath, `Music/${deviceName}.mpc`);
    return trackId;
  }

  itDb("resolves the shadow path back to the track it was made from", () => {
    const trackId = seedShadowSynced("source-one", "on-device-one");

    const resolver = buildDevicePathResolver(db, deviceId);
    expect(resolver.resolve("/<HDD0>/Music/on-device-one.mpc")).toBe(trackId);
    // The row counts as known, which is what the import reports on.
    expect(resolver.knownPaths).toBe(1);
  });

  itDb("still resolves a device fed by the primary library", () => {
    // The shadow join is an addition, not a replacement — the ordinary case
    // has to keep working through the same query.
    const trackId = seedTrack(db, {
      path: "/library/primary.flac",
      libraryFolderId: folderId,
    });
    db.prepare(
      `INSERT INTO device_synced_tracks (device_id, library_path, device_path)
       VALUES (?, ?, ?)`
    ).run(deviceId, "/library/primary.flac", "Music/renamed-on-device.mp3");

    const resolver = buildDevicePathResolver(db, deviceId);
    expect(resolver.resolve("/<HDD0>/Music/renamed-on-device.mp3")).toBe(trackId);
  });

  itDb("ignores a synced row whose source is neither a track nor a shadow", () => {
    // A row left behind by a deleted track must not become a null-id entry that
    // poisons the map, and must not throw.
    db.prepare(
      `INSERT INTO device_synced_tracks (device_id, library_path, device_path)
       VALUES (?, ?, ?)`
    ).run(deviceId, "/library/gone.flac", "Music/gone.mp3");
    const kept = seedShadowSynced("source-two", "on-device-two");

    const resolver = buildDevicePathResolver(db, deviceId);
    expect(resolver.resolve("/<HDD0>/Music/gone.mp3")).toBeNull();
    expect(resolver.resolve("/<HDD0>/Music/on-device-two.mpc")).toBe(kept);
    expect(resolver.knownPaths).toBe(1);
  });

  itDb("refuses two shadow tracks that landed on one device path", () => {
    // Two library tracks claiming one file on the device: neither can be
    // trusted, and a runtime counter must not be credited to a guess.
    seedShadowSynced("source-a", "collide");
    seedShadowSynced("source-b", "collide");

    const resolver = buildDevicePathResolver(db, deviceId);
    expect(resolver.resolve("/<HDD0>/Music/collide.mpc")).toBeNull();
  });

  itDb("matches the shadow transcode even when the check never ran", () => {
    // No device_synced_tracks row at all — a device the user has never checked.
    // The shadow file keeps the library's own name, so the codec-independent
    // tiers carry it, which is the other half of the fix.
    const trackId = seedTrack(db, {
      path: "/library/AC_DC/Back in Black/01 Hells Bells.flac",
      artist: "AC/DC",
      album: "Back in Black",
      libraryFolderId: folderId,
    });

    const resolver = buildDevicePathResolver(db, deviceId);
    expect(resolver.knownPaths).toBe(0);
    expect(
      resolver.resolve("/<HDD0>/Music/AC_DC/Back in Black/01 Hells Bells.mpc")
    ).toBe(trackId);
  });
});
