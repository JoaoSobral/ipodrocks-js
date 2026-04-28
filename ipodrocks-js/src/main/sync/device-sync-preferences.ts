import type Database from "better-sqlite3";
import type { CustomSelections, DeviceSyncPreferences } from "../../shared/types";

const emptySelections = (): CustomSelections => ({
  albums: [],
  artists: [],
  genres: [],
  podcasts: [],
  audiobooks: [],
  playlists: [],
});

function parseSelections(json: string | null | undefined): CustomSelections {
  if (!json) return emptySelections();
  try {
    const parsed = JSON.parse(json) as Partial<CustomSelections>;
    return {
      albums: Array.isArray(parsed.albums) ? parsed.albums : [],
      artists: Array.isArray(parsed.artists) ? parsed.artists : [],
      genres: Array.isArray(parsed.genres) ? parsed.genres : [],
      podcasts: Array.isArray(parsed.podcasts) ? parsed.podcasts : [],
      audiobooks: Array.isArray(parsed.audiobooks) ? parsed.audiobooks : [],
      playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
    };
  } catch {
    return emptySelections();
  }
}

type Row = {
  sync_type: string;
  extra_track_policy: string;
  include_music: number;
  include_podcasts: number;
  include_audiobooks: number;
  include_playlists: number;
  ignore_space_check: number;
  skip_album_artwork: number;
  custom_selections_json: string | null;
};

export function getDeviceSyncPreferences(
  db: Database.Database,
  deviceId: number
): DeviceSyncPreferences | null {
  const row = db
    .prepare("SELECT * FROM device_sync_preferences WHERE device_id = ?")
    .get(deviceId) as Row | undefined;
  if (!row) return null;
  return {
    syncType: row.sync_type,
    extraTrackPolicy: row.extra_track_policy,
    includeMusic: row.include_music === 1,
    includePodcasts: row.include_podcasts === 1,
    includeAudiobooks: row.include_audiobooks === 1,
    includePlaylists: row.include_playlists === 1,
    ignoreSpaceCheck: row.ignore_space_check === 1,
    skipAlbumArtwork: row.skip_album_artwork === 1,
    selections: parseSelections(row.custom_selections_json),
  };
}

export function saveDeviceSyncPreferences(
  db: Database.Database,
  deviceId: number,
  prefs: DeviceSyncPreferences
): void {
  db.prepare(`
    INSERT INTO device_sync_preferences
      (device_id, sync_type, extra_track_policy, include_music, include_podcasts,
       include_audiobooks, include_playlists, ignore_space_check, skip_album_artwork,
       custom_selections_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET
      sync_type = excluded.sync_type,
      extra_track_policy = excluded.extra_track_policy,
      include_music = excluded.include_music,
      include_podcasts = excluded.include_podcasts,
      include_audiobooks = excluded.include_audiobooks,
      include_playlists = excluded.include_playlists,
      ignore_space_check = excluded.ignore_space_check,
      skip_album_artwork = excluded.skip_album_artwork,
      custom_selections_json = excluded.custom_selections_json,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    deviceId,
    prefs.syncType,
    prefs.extraTrackPolicy,
    prefs.includeMusic ? 1 : 0,
    prefs.includePodcasts ? 1 : 0,
    prefs.includeAudiobooks ? 1 : 0,
    prefs.includePlaylists ? 1 : 0,
    prefs.ignoreSpaceCheck ? 1 : 0,
    prefs.skipAlbumArtwork ? 1 : 0,
    JSON.stringify(prefs.selections)
  );
}
