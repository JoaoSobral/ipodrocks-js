import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import {
  Playlist,
  PlaylistTrack,
  SmartPlaylistRule,
  GeniusPlaylistConfig,
  ArtistInfo,
  AlbumInfo,
  GenreInfo,
} from "../../shared/types";
import { SmartPlaylistGenerator } from "./smart-playlists";
import { computeDeviceRelativePath } from "../sync/sync-core";
import { updateExtension } from "../sync/sync-conversion";

interface PlaylistRow {
  id: number;
  name: string;
  description: string | null;
  type_name: string;
  created_at: string;
  updated_at: string;
  track_count: number;
}

interface TrackRow {
  id: number;
  path: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  duration: number | null;
  library_folder_id: number | null;
}

interface RuleRow {
  id: number;
  rule_type: string;
  target_id: number | null;
  target_label: string | null;
}

interface GeniusConfigRow {
  id: number;
  genius_type: string;
  device_id: number | null;
  track_limit: number;
  last_generated_at: string | null;
}

const PLAYLIST_SELECT = `
  SELECT p.id, p.name, p.description, pt.name AS type_name,
         p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM playlist_items pi
          WHERE pi.playlist_id = p.id) AS track_count
  FROM playlists p
  JOIN playlist_types pt ON p.playlist_type_id = pt.id
`;

const TRACK_SELECT = `
  SELECT t.id, t.path, t.filename, t.title,
         a.name AS artist, al.title AS album,
         g.name AS genre, t.duration,
         t.library_folder_id
  FROM playlist_items pi
  JOIN tracks t ON pi.track_id = t.id
  LEFT JOIN artists a ON t.artist_id = a.id
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN genres g ON t.genre_id = g.id
  WHERE pi.playlist_id = ?
  ORDER BY pi.position
`;

/**
 * High-level playlist management.
 *
 * Provides CRUD operations, smart track resolution,
 * genius generation wiring, and M3U export.
 */
export class PlaylistCore {
  private db: Database.Database;
  private stmtGetAll: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtGetTracks: Database.Statement;
  private stmtDeletePlaylist: Database.Statement;
  private stmtDeleteItems: Database.Statement;
  private stmtDeleteSmartRules: Database.Statement;
  private stmtDeleteGeniusConfig: Database.Statement;
  private stmtInsertPlaylist: Database.Statement;
  private stmtInsertItem: Database.Statement;
  private stmtInsertSmartRule: Database.Statement;
  private stmtGetSmartRules: Database.Statement;
  private stmtGetGeniusConfig: Database.Statement;
  private stmtInsertGeniusConfig: Database.Statement;
  private stmtUpdatePlaylist: Database.Statement;
  private stmtUpdateGeniusTimestamp: Database.Statement;
  private stmtUpdatePlaylistTimestamp: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtGetAll = db.prepare(PLAYLIST_SELECT + " ORDER BY p.name");
    this.stmtGetById = db.prepare(PLAYLIST_SELECT + " WHERE p.id = ?");
    this.stmtGetTracks = db.prepare(TRACK_SELECT);
    this.stmtDeletePlaylist = db.prepare("DELETE FROM playlists WHERE id = ?");
    this.stmtDeleteItems = db.prepare(
      "DELETE FROM playlist_items WHERE playlist_id = ?"
    );
    this.stmtDeleteSmartRules = db.prepare(
      "DELETE FROM smart_playlist_rules WHERE playlist_id = ?"
    );
    this.stmtDeleteGeniusConfig = db.prepare(
      "DELETE FROM genius_playlist_configs WHERE playlist_id = ?"
    );
    this.stmtInsertPlaylist = db.prepare(`
      INSERT INTO playlists (name, description, playlist_type_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.stmtInsertItem = db.prepare(`
      INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position)
      VALUES (?, ?, ?)
    `);
    this.stmtInsertSmartRule = db.prepare(`
      INSERT INTO smart_playlist_rules (playlist_id, rule_type, target_id, target_label)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtGetSmartRules = db.prepare(`
      SELECT id, rule_type, target_id, target_label
      FROM smart_playlist_rules WHERE playlist_id = ?
    `);
    this.stmtGetGeniusConfig = db.prepare(`
      SELECT id, genius_type, device_id, track_limit, last_generated_at
      FROM genius_playlist_configs WHERE playlist_id = ?
    `);
    this.stmtInsertGeniusConfig = db.prepare(`
      INSERT INTO genius_playlist_configs
        (playlist_id, genius_type, device_id, track_limit, last_generated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.stmtUpdatePlaylist = db.prepare(
      "UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?"
    );
    this.stmtUpdateGeniusTimestamp = db.prepare(
      "UPDATE genius_playlist_configs SET last_generated_at = ? WHERE playlist_id = ?"
    );
    this.stmtUpdatePlaylistTimestamp = db.prepare(
      "UPDATE playlists SET updated_at = ? WHERE id = ?"
    );
  }

  // -- helpers ------------------------------------------------------------

  private _playlistTypeId(name: string): number | undefined {
    const row = this.db
      .prepare("SELECT id FROM playlist_types WHERE name = ?")
      .get(name) as { id: number } | undefined;
    return row?.id;
  }

  private _rowToPlaylist(r: PlaylistRow): Playlist {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      typeName: r.type_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      trackCount: r.track_count,
    };
  }

  private _rowToTrack(r: TrackRow): PlaylistTrack {
    return {
      id: r.id,
      path: r.path,
      filename: r.filename,
      title: r.title || r.filename,
      artist: r.artist || "Unknown",
      album: r.album || "Unknown",
      genre: r.genre || "Unknown",
      duration: r.duration || 0,
      libraryFolderId: r.library_folder_id ?? undefined,
    };
  }

  // -- list / get ---------------------------------------------------------

  /**
   * Return all playlists, optionally filtered by type name.
   * @param playlistType - 'smart', 'genius', or undefined for all.
   */
  getPlaylists(playlistType?: string): Playlist[] {
    if (playlistType) {
      const stmt = this.db.prepare(
        PLAYLIST_SELECT + " WHERE pt.name = ? ORDER BY p.name"
      );
      return (stmt.all(playlistType) as PlaylistRow[]).map((r) =>
        this._rowToPlaylist(r)
      );
    }
    return (this.stmtGetAll.all() as PlaylistRow[]).map((r) =>
      this._rowToPlaylist(r)
    );
  }

  /**
   * Return a single playlist with metadata and track count.
   * @param playlistId - Playlist primary key.
   */
  getPlaylistById(playlistId: number): Playlist | undefined {
    const row = this.stmtGetById.get(playlistId) as PlaylistRow | undefined;
    return row ? this._rowToPlaylist(row) : undefined;
  }

  // -- smart playlist CRUD ------------------------------------------------

  /**
   * Create a smart playlist, persist rules, resolve tracks.
   * @param name - Playlist display name.
   * @param rules - Rule definitions with ruleType, targetId, targetLabel.
   * @param description - Optional description.
   * @param trackLimit - Optional max number of tracks to include.
   * @returns New playlist id.
   */
  createSmartPlaylist(
    name: string,
    rules: SmartPlaylistRule[],
    description = "",
    trackLimit?: number
  ): number {
    const typeId = this._playlistTypeId("smart");
    if (!typeId) throw new Error("Playlist type 'smart' not found");
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      const info = this.stmtInsertPlaylist.run(
        name,
        description,
        typeId,
        now,
        now
      );
      const playlistId = Number(info.lastInsertRowid);

      for (const rule of rules) {
        this.stmtInsertSmartRule.run(
          playlistId,
          rule.ruleType,
          rule.targetId,
          rule.targetLabel || ""
        );
      }

      this._resolveSmartTracks(playlistId, rules, trackLimit);
      return playlistId;
    });

    return run();
  }

  /**
   * Update an existing smart playlist's name, rules, and tracks.
   * @param playlistId - Playlist id to update.
   * @param name - New name.
   * @param rules - New rules list.
   * @param description - New description.
   */
  updateSmartPlaylist(
    playlistId: number,
    name: string,
    rules: SmartPlaylistRule[],
    description = ""
  ): boolean {
    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      this.stmtUpdatePlaylist.run(name, description, now, playlistId);
      this.stmtDeleteSmartRules.run(playlistId);

      for (const rule of rules) {
        this.stmtInsertSmartRule.run(
          playlistId,
          rule.ruleType,
          rule.targetId,
          rule.targetLabel || ""
        );
      }

      this.stmtDeleteItems.run(playlistId);
      this._resolveSmartTracks(playlistId, rules, undefined);
    });

    run();
    return true;
  }

  /**
   * Get smart playlist rules for a playlist.
   * @param playlistId - Playlist id.
   */
  getSmartRules(playlistId: number): SmartPlaylistRule[] {
    const rows = this.stmtGetSmartRules.all(playlistId) as RuleRow[];
    return rows.map((r) => ({
      id: r.id,
      ruleType: r.rule_type,
      targetId: r.target_id,
      targetLabel: r.target_label ?? "",
    }));
  }

  // -- genius playlist CRUD -----------------------------------------------

  /**
   * Create a genius playlist with pre-resolved track IDs.
   *
   * Track generation now happens in the genius-engine before this call;
   * this method only persists the playlist, config, and items.
   *
   * @param geniusType - Algorithm key (e.g. ``most_played``).
   * @param trackIds - Ordered track IDs to insert.
   * @param deviceId - Device that was analysed (null = global).
   * @param trackLimit - Limit stored in config for reference.
   * @param name - Playlist display name.
   * @returns New playlist id.
   */
  createGeniusPlaylist(
    geniusType: string,
    trackIds: number[],
    deviceId: number | null = null,
    trackLimit = 50,
    name?: string
  ): number {
    const typeId = this._playlistTypeId("genius");
    if (!typeId) throw new Error("Playlist type 'genius' not found");
    const now = new Date().toISOString();

    const displayName = name ||
      geniusType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const scopeLabel = deviceId === null ? "Global" : `Device #${deviceId}`;
    const description = `${geniusType} | ${scopeLabel} | limit ${trackLimit}`;

    const run = this.db.transaction(() => {
      const info = this.stmtInsertPlaylist.run(
        displayName,
        description,
        typeId,
        now,
        now
      );
      const playlistId = Number(info.lastInsertRowid);

      this.stmtInsertGeniusConfig.run(
        playlistId,
        geniusType,
        deviceId,
        trackLimit,
        now
      );

      for (let pos = 0; pos < trackIds.length; pos++) {
        this.stmtInsertItem.run(playlistId, trackIds[pos], pos + 1);
      }

      return playlistId;
    });

    return run();
  }

  /**
   * Replace the tracks of an existing genius playlist.
   *
   * Called after re-analysing the device and regenerating via the engine.
   *
   * @param playlistId - Playlist to update.
   * @param trackIds - New ordered track IDs.
   */
  replaceGeniusTracks(playlistId: number, trackIds: number[]): boolean {
    const config = this.stmtGetGeniusConfig.get(playlistId) as
      | GeniusConfigRow
      | undefined;
    if (!config) return false;

    const now = new Date().toISOString();

    const run = this.db.transaction(() => {
      this.stmtDeleteItems.run(playlistId);
      for (let pos = 0; pos < trackIds.length; pos++) {
        this.stmtInsertItem.run(playlistId, trackIds[pos], pos + 1);
      }
      this.stmtUpdateGeniusTimestamp.run(now, playlistId);
      this.stmtUpdatePlaylistTimestamp.run(now, playlistId);
    });

    run();
    return true;
  }


  /**
   * Get genius config for a playlist.
   * @param playlistId - Playlist id.
   */
  getGeniusConfig(playlistId: number): GeniusPlaylistConfig | undefined {
    const row = this.stmtGetGeniusConfig.get(playlistId) as
      | GeniusConfigRow
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      geniusType: row.genius_type,
      deviceId: row.device_id,
      trackLimit: row.track_limit,
      lastGeneratedAt: row.last_generated_at,
    };
  }

  // -- delete -------------------------------------------------------------

  /**
   * Delete a playlist (manual cascade for rules, config, items).
   * @param playlistId - Playlist to delete.
   */
  deletePlaylist(playlistId: number): boolean {
    const run = this.db.transaction(() => {
      this.stmtDeleteSmartRules.run(playlistId);
      this.stmtDeleteGeniusConfig.run(playlistId);
      this.stmtDeleteItems.run(playlistId);
      this.stmtDeletePlaylist.run(playlistId);
    });

    run();
    return true;
  }

  // -- tracks -------------------------------------------------------------

  /**
   * Return ordered track list for a playlist.
   * @param playlistId - Playlist id.
   */
  getPlaylistTracks(playlistId: number): PlaylistTrack[] {
    const rows = this.stmtGetTracks.all(playlistId) as TrackRow[];
    return rows.map((r) => this._rowToTrack(r));
  }

  /**
   * Batch-add tracks to a playlist at the end of the current positions.
   * @param playlistId - Target playlist.
   * @param trackIds - Track ids to add.
   */
  addTracksToPlaylist(playlistId: number, trackIds: number[]): void {
    const maxRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), 0) AS max_pos FROM playlist_items WHERE playlist_id = ?"
      )
      .get(playlistId) as { max_pos: number };

    let pos = maxRow.max_pos;
    const insert = this.db.transaction(() => {
      for (const tid of trackIds) {
        pos++;
        this.stmtInsertItem.run(playlistId, tid, pos);
      }
    });
    insert();
  }

  /**
   * Return the union of all tracks across the given playlists (de-duplicated).
   * Used by SyncCore to ensure every track exists on device.
   * @param playlistIds - List of playlist ids.
   */
  getTracksForSync(playlistIds: number[]): PlaylistTrack[] {
    if (!playlistIds.length) return [];
    const placeholders = playlistIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.id, t.path, t.filename, t.title,
                a.name AS artist, al.title AS album,
                g.name AS genre, t.duration,
                t.library_folder_id
         FROM playlist_items pi
         JOIN tracks t ON pi.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE pi.playlist_id IN (${placeholders})
         ORDER BY t.artist_id, t.album_id, t.title`
      )
      .all(...playlistIds) as TrackRow[];
    return rows.map((r) => this._rowToTrack(r));
  }

  // -- M3U export ---------------------------------------------------------

  /**
   * Build M3U file content with device-relative paths and codec-aware extensions.
   * Paths are in the form /Music/Artist/Album/track.ext for use on the device.
   */
  buildM3uContentForDevice(
    playlistId: number,
    options: {
      musicFolder: string;
      codecName: string;
      libraryFolderPaths?: Map<number, string>;
    }
  ): string {
    const playlist = this.getPlaylistById(playlistId);
    const tracks = this.getPlaylistTracks(playlistId);
    const pname = playlist?.name ?? "Unknown";

    const musicFolder = options.musicFolder ?? "Music";
    const codecUpper = (options.codecName ?? "COPY").toUpperCase();
    const needsConversion = !["DIRECT COPY", "COPY", "NONE"].includes(codecUpper);
    const codecLower = needsConversion ? options.codecName.toLowerCase() : "copy";

    const lines: string[] = [
      "#EXTM3U",
      `# Generated by iPodRock: ${pname}`,
      `# Generated: ${new Date().toISOString()}`,
      "",
    ];

    for (const track of tracks) {
      const dur = Math.floor(track.duration);
      const trackPath = track.path;
      if (!trackPath) continue;

      const trackInfo: Record<string, unknown> = {
        artist: track.artist,
        album: track.album,
        libraryFolderId: track.libraryFolderId,
      };
      let relPath = computeDeviceRelativePath(
        trackPath,
        trackInfo,
        "music",
        options.libraryFolderPaths
      );
      if (needsConversion) {
        relPath = updateExtension(relPath, codecLower);
      }
      const devicePath = `/${musicFolder}/${relPath.replace(/\\/g, "/")}`;

      lines.push(`#EXTINF:${dur},${track.artist} - ${track.title}`);
      lines.push(devicePath);
    }

    return lines.join("\n");
  }

  /**
   * Write an M3U file with device-relative paths and codec-aware extensions.
   *
   * @param playlistId - Playlist to export.
   * @param outputPath - Destination file path.
   * @param options - musicFolder, codecName, and optional libraryFolderPaths.
   */
  exportPlaylistM3u(
    playlistId: number,
    outputPath: string,
    options: {
      musicFolder: string;
      codecName: string;
      libraryFolderPaths?: Map<number, string>;
    }
  ): string {
    const content = this.buildM3uContentForDevice(playlistId, options);
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, content, "utf-8");
    return outputPath;
  }

  // -- library metadata for UI --------------------------------------------

  /** Return all artists with track counts. */
  getArtists(): ArtistInfo[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.name, COUNT(t.id) AS track_count
         FROM artists a
         LEFT JOIN tracks t ON t.artist_id = a.id AND t.content_type = 'music'
         GROUP BY a.id ORDER BY a.name`
      )
      .all() as { id: number; name: string; track_count: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      trackCount: r.track_count,
    }));
  }

  /** Return all albums with artist name and track counts. */
  getAlbums(): AlbumInfo[] {
    const rows = this.db
      .prepare(
        `SELECT al.id, al.title, a.name AS artist, al.artist_id,
                COUNT(t.id) AS track_count
         FROM albums al
         LEFT JOIN artists a ON al.artist_id = a.id
         LEFT JOIN tracks t ON t.album_id = al.id AND t.content_type = 'music'
         GROUP BY al.id ORDER BY a.name, al.title`
      )
      .all() as {
      id: number;
      title: string;
      artist: string | null;
      artist_id: number;
      track_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist || "Unknown",
      artistId: r.artist_id,
      trackCount: r.track_count,
    }));
  }

  /** Return all genres with track counts. */
  getGenres(): GenreInfo[] {
    const rows = this.db
      .prepare(
        `SELECT g.id, g.name, COUNT(t.id) AS track_count
         FROM genres g
         LEFT JOIN tracks t ON t.genre_id = g.id AND t.content_type = 'music'
         GROUP BY g.id ORDER BY g.name`
      )
      .all() as { id: number; name: string; track_count: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      trackCount: r.track_count,
    }));
  }


  // -- internal: smart track resolution -----------------------------------

  /**
   * Query tracks matching the rule set and insert into playlist_items.
   *
   * Multiple rules of the same type are OR'd; different types are AND'd.
   * @param trackLimit - Optional max tracks to insert.
   */
  private _resolveSmartTracks(
    playlistId: number,
    rules: SmartPlaylistRule[],
    trackLimit?: number
  ): void {
    let trackIds = this._queryTracksForRules(rules);
    if (trackLimit != null && trackLimit > 0) {
      trackIds = trackIds.slice(0, trackLimit);
    }
    for (let pos = 0; pos < trackIds.length; pos++) {
      this.stmtInsertItem.run(playlistId, trackIds[pos], pos + 1);
    }
  }

  private _queryTracksForRules(rules: SmartPlaylistRule[]): number[] {
    if (!rules.length) return [];

    const byType: Record<string, SmartPlaylistRule[]> = {};
    for (const rule of rules) {
      (byType[rule.ruleType] ??= []).push(rule);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const [ruleType, group] of Object.entries(byType)) {
      const ids = group
        .filter((r) => r.targetId != null)
        .map((r) => r.targetId);
      if (!ids.length) continue;
      const ph = ids.map(() => "?").join(",");

      if (ruleType === "artist") conditions.push(`t.artist_id IN (${ph})`);
      else if (ruleType === "album") conditions.push(`t.album_id IN (${ph})`);
      else if (ruleType === "genre") conditions.push(`t.genre_id IN (${ph})`);
      else continue;

      params.push(...ids);
    }

    if (!conditions.length) return [];

    const where = conditions.join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT t.id FROM tracks t
         WHERE t.content_type = 'music' AND ${where}
         ORDER BY t.artist_id, t.album_id, t.title`
      )
      .all(...params) as { id: number }[];
    return rows.map((r) => r.id);
  }

}
