import type Database from "better-sqlite3";
import type {
  AlbumGrouping,
  CustomSelections,
  DeviceSyncPreferences,
  ExtraTrackPolicy,
} from "../../shared/types";

export const emptySelections = (): CustomSelections => ({
  mode: "include",
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
      mode: parsed.mode === "exclude" ? "exclude" : "include",
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
  preserve_folder_structure: number;
  album_grouping: string | null;
  custom_selections_json: string | null;
};

function parseAlbumGrouping(value: string | null | undefined): AlbumGrouping {
  return value === "track-artist" ? "track-artist" : "album-artist";
}

/**
 * A stored `remove-all` predates the "Delete all" option and must NOT load as
 * `delete-all`. The old option swept orphans and unlinked the auto-podcast and
 * extra-audiobook files iPodRocks had recorded; the new one erases the device's
 * content folders. Mapping it to `remove` — which now sweeps every content type
 * — is the closest honest match, and it means nobody who ticked the old box
 * once gets their device wiped by an upgrade.
 */
function parseExtraTrackPolicy(value: string | null | undefined): ExtraTrackPolicy {
  if (value === "remove-all") return "remove";
  return value === "remove" || value === "delete-all" || value === "prompt"
    ? value
    : "keep";
}

export function getDeviceSyncPreferences(
  db: Database.Database,
  deviceId: number
): DeviceSyncPreferences | null {
  const row = db
    .prepare("SELECT * FROM device_sync_preferences WHERE device_id = ?")
    .get(deviceId) as Row | undefined;
  if (!row) return null;
  return {
    syncType: row.sync_type === "custom" ? "custom" : "full",
    extraTrackPolicy: parseExtraTrackPolicy(row.extra_track_policy),
    includeMusic: row.include_music === 1,
    includePodcasts: row.include_podcasts === 1,
    includeAudiobooks: row.include_audiobooks === 1,
    includePlaylists: row.include_playlists === 1,
    preserveFolderStructure: row.preserve_folder_structure !== 0,
    albumGrouping: parseAlbumGrouping(row.album_grouping),
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
       include_audiobooks, include_playlists,
       preserve_folder_structure, album_grouping, custom_selections_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id) DO UPDATE SET
      sync_type = excluded.sync_type,
      extra_track_policy = excluded.extra_track_policy,
      include_music = excluded.include_music,
      include_podcasts = excluded.include_podcasts,
      include_audiobooks = excluded.include_audiobooks,
      include_playlists = excluded.include_playlists,
      preserve_folder_structure = excluded.preserve_folder_structure,
      album_grouping = excluded.album_grouping,
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
    prefs.preserveFolderStructure ? 1 : 0,
    parseAlbumGrouping(prefs.albumGrouping),
    JSON.stringify(prefs.selections)
  );
}
