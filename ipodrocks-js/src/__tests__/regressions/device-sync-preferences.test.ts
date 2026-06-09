/**
 * @vitest-environment node
 *
 * Round-trips device sync preferences through SQLite to verify the new
 * include/exclude polarity field persists and is back-compatible with
 * pre-existing rows that have no `mode` field in their JSON.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  canRunDbTests,
  closeDb,
  createTestDb,
  type TestDb,
} from "../harness";
import {
  getDeviceSyncPreferences,
  saveDeviceSyncPreferences,
  emptySelections,
} from "../../main/sync/device-sync-preferences";

const itDb = it.skipIf(!canRunDbTests);

function seedDevice(db: TestDb, id: number): void {
  db.prepare(
    `INSERT INTO devices (id, name, mount_path, music_folder, podcast_folder,
     audiobook_folder, playlist_folder, model_id, default_codec_config_id,
     default_transfer_mode_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)`
  ).run(id, `Dev${id}`, `/mnt/dev${id}`, "Music", "Podcasts", "Audiobooks", "Playlists");
}

describe("device_sync_preferences — exclude mode persistence", () => {
  let db: TestDb | null = null;

  afterEach(() => {
    closeDb(db);
    db = null;
  });

  itDb("emptySelections() defaults mode to 'include'", () => {
    expect(emptySelections().mode).toBe("include");
  });

  itDb("round-trips mode: 'exclude' through save → load", () => {
    db = createTestDb();
    seedDevice(db, 1);

    saveDeviceSyncPreferences(db, 1, {
      syncType: "custom",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: true,
      includeAudiobooks: true,
      includePlaylists: true,
      ignoreSpaceCheck: false,
      skipAlbumArtwork: false,
      selections: {
        mode: "exclude",
        albums: ["Album A"],
        artists: ["Artist Z"],
        genres: [],
        podcasts: [],
        audiobooks: [],
        playlists: [],
      },
    });

    const loaded = getDeviceSyncPreferences(db, 1);
    expect(loaded).not.toBeNull();
    expect(loaded!.selections.mode).toBe("exclude");
    expect(loaded!.selections.albums).toEqual(["Album A"]);
    expect(loaded!.selections.artists).toEqual(["Artist Z"]);
  });

  itDb("round-trips mode: 'include' through save → load", () => {
    db = createTestDb();
    seedDevice(db, 2);

    saveDeviceSyncPreferences(db, 2, {
      syncType: "custom",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: true,
      includeAudiobooks: true,
      includePlaylists: true,
      ignoreSpaceCheck: false,
      skipAlbumArtwork: false,
      selections: { ...emptySelections(), mode: "include", albums: ["X"] },
    });

    const loaded = getDeviceSyncPreferences(db, 2);
    expect(loaded!.selections.mode).toBe("include");
    expect(loaded!.selections.albums).toEqual(["X"]);
  });

  itDb("parses rows written before mode existed as mode: 'include'", () => {
    db = createTestDb();
    seedDevice(db, 3);

    // Simulate a pre-existing row: write the JSON without a `mode` field.
    const legacyJson = JSON.stringify({
      albums: ["LegacyAlbum"],
      artists: [],
      genres: [],
      podcasts: [],
      audiobooks: [],
      playlists: [],
    });
    db.prepare(
      `INSERT INTO device_sync_preferences
       (device_id, sync_type, extra_track_policy, include_music, include_podcasts,
        include_audiobooks, include_playlists, ignore_space_check, skip_album_artwork,
        custom_selections_json)
       VALUES (?, 'custom', 'keep', 1, 1, 1, 1, 0, 0, ?)`
    ).run(3, legacyJson);

    const loaded = getDeviceSyncPreferences(db, 3);
    expect(loaded).not.toBeNull();
    expect(loaded!.selections.mode).toBe("include");
    expect(loaded!.selections.albums).toEqual(["LegacyAlbum"]);
  });

  itDb("parses an invalid mode value as 'include'", () => {
    db = createTestDb();
    seedDevice(db, 4);

    const garbageJson = JSON.stringify({
      mode: "garbage",
      albums: [],
      artists: [],
      genres: [],
      podcasts: [],
      audiobooks: [],
      playlists: [],
    });
    db.prepare(
      `INSERT INTO device_sync_preferences
       (device_id, sync_type, extra_track_policy, include_music, include_podcasts,
        include_audiobooks, include_playlists, ignore_space_check, skip_album_artwork,
        custom_selections_json)
       VALUES (?, 'custom', 'keep', 1, 1, 1, 1, 0, 0, ?)`
    ).run(4, garbageJson);

    const loaded = getDeviceSyncPreferences(db, 4);
    expect(loaded!.selections.mode).toBe("include");
  });
});
