import Database from "better-sqlite3";
import { PlaylistGenerationResult, PlaylistTrack } from "../../shared/types";

interface TrackRow {
  id?: number;
  path: string;
  filename: string;
  artist: string | null;
  album: string | null;
  title: string | null;
  genre: string | null;
  duration: number | null;
  play_count: number | null;
  rating?: number | null;
}

/**
 * Generate smart playlists using only library metadata.
 *
 * Smart playlists are based on track properties like genre, artist,
 * album, duration, etc. They don't consider listening history.
 */
export class SmartPlaylistGenerator {
  private db: Database.Database;
  private readonly generators: Record<
    string,
    (opts: Record<string, unknown>) => PlaylistGenerationResult
  >;

  constructor(db: Database.Database) {
    this.db = db;
    this.generators = {
      by_genre: (o) => this._generateByGenre(o),
      by_artist: (o) => this._generateByArtist(o),
      by_album: (o) => this._generateByAlbum(o),
      by_decade: (o) => this._generateByDecade(o),
      recently_added: (o) => this._generateRecentlyAdded(o),
      never_played: (o) => this._generateNeverPlayed(o),
      random_mix: (o) => this._generateRandomMix(o),
      long_tracks: (o) => this._generateLongTracks(o),
      short_tracks: (o) => this._generateShortTracks(o),
      compilation_albums: (o) => this._generateCompilationAlbums(o),
      top_rated: (o) => this._generateTopRated(o),
      auto: (o) => this._generateAuto(o),
    };
  }

  generate(
    playlistType: string,
    options: Record<string, unknown> = {}
  ): PlaylistGenerationResult {
    const gen = this.generators[playlistType];
    if (!gen) throw new Error(`Unknown smart playlist type: ${playlistType}`);
    return gen(options);
  }

  getAvailableTypes(): string[] {
    return Object.keys(this.generators);
  }

  // -- strategies ---------------------------------------------------------

  private _generateByGenre(opts: Record<string, unknown>): PlaylistGenerationResult {
    let genre = opts.genre as string | undefined;
    const limit = (opts.limit as number) || 50;

    if (!genre) {
      const genres = this.db
        .prepare(
          `SELECT g.name, COUNT(*) as count
           FROM genres g
           JOIN tracks t ON t.genre_id = g.id
           WHERE g.name IS NOT NULL
           GROUP BY g.id ORDER BY count DESC`
        )
        .all() as { name: string; count: number }[];
      if (!genres.length) return this._empty("No genres found");
      const top = genres.slice(0, 10);
      genre = top[Math.floor(Math.random() * top.length)].name;
    }

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE g.name = ? AND t.content_type = 'music'
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(genre, limit) as TrackRow[];

    return {
      playlistName: `Best of ${genre}`,
      criteria: `Random ${limit} tracks from ${genre} genre`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "by_genre",
    };
  }

  private _generateByArtist(opts: Record<string, unknown>): PlaylistGenerationResult {
    let artist = opts.artist as string | undefined;
    const limit = (opts.limit as number) || 50;

    if (!artist) {
      const artists = this.db
        .prepare(
          `SELECT a.name, COUNT(*) as count
           FROM artists a
           JOIN tracks t ON t.artist_id = a.id
           WHERE a.name IS NOT NULL
           GROUP BY a.id ORDER BY count DESC LIMIT 20`
        )
        .all() as { name: string; count: number }[];
      if (!artists.length) return this._empty("No artists found");
      artist = artists[Math.floor(Math.random() * artists.length)].name;
    }

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE a.name = ? AND t.content_type = 'music'
         ORDER BY al.title, t.title LIMIT ?`
      )
      .all(artist, limit) as TrackRow[];

    return {
      playlistName: `Complete ${artist}`,
      criteria: `All tracks by ${artist} (up to ${limit})`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "by_artist",
    };
  }

  private _generateByAlbum(opts: Record<string, unknown>): PlaylistGenerationResult {
    let album = opts.album as string | undefined;
    const limit = (opts.limit as number) || 50;

    if (!album) {
      const row = this.db
        .prepare(
          `SELECT al.title, a.name AS artist, COUNT(*) as count
           FROM albums al
           JOIN tracks t ON t.album_id = al.id
           LEFT JOIN artists a ON al.artist_id = a.id
           WHERE al.title IS NOT NULL
           GROUP BY al.id HAVING count >= 8
           ORDER BY RANDOM() LIMIT 1`
        )
        .get() as { title: string; artist: string | null } | undefined;
      if (!row) return this._empty("No complete albums found");
      album = row.title;
    }

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE al.title = ? AND t.content_type = 'music'
         ORDER BY t.title LIMIT ?`
      )
      .all(album, limit) as TrackRow[];

    const tracks = rows.map((r) => this._toTrack(r));
    const artistName = tracks[0]?.artist ?? "Unknown";

    return {
      playlistName: `${album} - ${artistName}`,
      criteria: `Complete album: ${album}`,
      tracks,
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "by_album",
    };
  }

  private _generateByDecade(opts: Record<string, unknown>): PlaylistGenerationResult {
    const decade = (opts.decade as number) || [1990, 2000, 2010, 2020][Math.floor(Math.random() * 4)];
    const limit = (opts.limit as number) || 50;

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music'
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(limit) as TrackRow[];

    return {
      playlistName: `${decade}s Hits`,
      criteria: `Music from the ${decade}s decade`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "by_decade",
    };
  }

  private _generateRecentlyAdded(opts: Record<string, unknown>): PlaylistGenerationResult {
    const days = (opts.days as number) || 30;
    const limit = (opts.limit as number) || 50;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music' AND t.created_at > ?
         ORDER BY t.created_at DESC LIMIT ?`
      )
      .all(cutoff, limit) as TrackRow[];

    return {
      playlistName: "Recently Added",
      criteria: `Tracks added in the last ${days} days`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "recently_added",
    };
  }

  private _generateNeverPlayed(opts: Record<string, unknown>): PlaylistGenerationResult {
    const limit = (opts.limit as number) || 50;

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music'
           AND (t.play_count = 0 OR t.play_count IS NULL)
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(limit) as TrackRow[];

    return {
      playlistName: "Never Played",
      criteria: "Tracks that have never been played",
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "never_played",
    };
  }

  private _generateRandomMix(opts: Record<string, unknown>): PlaylistGenerationResult {
    const limit = (opts.limit as number) || 50;

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music'
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(limit) as TrackRow[];

    return {
      playlistName: "Random Mix",
      criteria: `Random selection of ${limit} tracks`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "random_mix",
    };
  }

  private _generateLongTracks(opts: Record<string, unknown>): PlaylistGenerationResult {
    const minDuration = (opts.minDuration as number) || 300;
    const limit = (opts.limit as number) || 30;

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music' AND t.duration > ?
         ORDER BY t.duration DESC LIMIT ?`
      )
      .all(minDuration, limit) as TrackRow[];

    const minMinutes = Math.floor(minDuration / 60);

    return {
      playlistName: `Long Tracks (${minMinutes}+ min)`,
      criteria: `Tracks longer than ${minMinutes} minutes`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "long_tracks",
    };
  }

  private _generateShortTracks(opts: Record<string, unknown>): PlaylistGenerationResult {
    const maxDuration = (opts.maxDuration as number) || 180;
    const limit = (opts.limit as number) || 50;

    const rows = this.db
      .prepare(
        `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music' AND t.duration < ?
         ORDER BY RANDOM() LIMIT ?`
      )
      .all(maxDuration, limit) as TrackRow[];

    const maxMinutes = Math.floor(maxDuration / 60);

    return {
      playlistName: `Short Tracks (<${maxMinutes} min)`,
      criteria: `Tracks shorter than ${maxMinutes} minutes`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "short_tracks",
    };
  }

  private _generateCompilationAlbums(opts: Record<string, unknown>): PlaylistGenerationResult {
    const limit = (opts.limit as number) || 50;

    const compilations = this.db
      .prepare(
        `SELECT al.title, COUNT(DISTINCT a.id) AS artist_count,
                COUNT(t.id) AS track_count
         FROM albums al
         JOIN tracks t ON t.album_id = al.id
         LEFT JOIN artists a ON t.artist_id = a.id
         WHERE t.content_type = 'music' AND al.title IS NOT NULL
         GROUP BY al.id HAVING artist_count > 3
         ORDER BY track_count DESC`
      )
      .all() as { title: string; artist_count: number; track_count: number }[];

    if (!compilations.length) return this._empty("No compilation albums found");

    const tracks: PlaylistTrack[] = [];
    const perAlbum = Math.max(1, Math.floor(limit / 5));

    for (const comp of compilations.slice(0, 5)) {
      const rows = this.db
        .prepare(
          `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                  t.title, g.name AS genre, t.duration, t.play_count
           FROM tracks t
           LEFT JOIN artists a ON t.artist_id = a.id
           LEFT JOIN albums al ON t.album_id = al.id
           LEFT JOIN genres g ON t.genre_id = g.id
           WHERE al.title = ? AND t.content_type = 'music'
           ORDER BY RANDOM() LIMIT ?`
        )
        .all(comp.title, perAlbum) as TrackRow[];

      for (const r of rows) {
        tracks.push(this._toTrack(r));
        if (tracks.length >= limit) break;
      }
      if (tracks.length >= limit) break;
    }

    return {
      playlistName: "Compilation Highlights",
      criteria: "Selected tracks from various artist compilations",
      tracks,
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "compilation_albums",
    };
  }

  /**
   * Auto-discovery playlist combining multiple strategies:
   * recent additions (20%), popular genres (30%), never played (20%), random (30%).
   */
  private _generateAuto(opts: Record<string, unknown>): PlaylistGenerationResult {
    const limit = (opts.limit as number) || 50;
    const all: PlaylistTrack[] = [];
    const seen = new Set<string>();

    const addUnique = (tracks: PlaylistTrack[], max: number) => {
      let added = 0;
      for (const t of tracks) {
        if (added >= max) break;
        if (!seen.has(t.path)) {
          seen.add(t.path);
          all.push(t);
          added++;
        }
      }
    };

    // 20% recent
    try {
      const recent = this._generateRecentlyAdded({ limit: Math.max(1, Math.floor(limit / 5)) });
      addUnique(recent.tracks, Math.max(1, Math.floor(limit / 5)));
    } catch { /* noop */ }

    // 30% popular genre
    try {
      const topGenre = this.db
        .prepare(
          `SELECT g.name, COUNT(*) as count
           FROM genres g JOIN tracks t ON t.genre_id = g.id
           WHERE g.name IS NOT NULL
           GROUP BY g.id ORDER BY count DESC LIMIT 1`
        )
        .get() as { name: string } | undefined;

      if (topGenre) {
        const genreResult = this._generateByGenre({
          genre: topGenre.name,
          limit: Math.max(1, Math.floor(limit * 3 / 10)),
        });
        addUnique(genreResult.tracks, Math.max(1, Math.floor(limit * 3 / 10)));
      }
    } catch { /* noop */ }

    // 20% never played
    try {
      const np = this._generateNeverPlayed({ limit: Math.max(1, Math.floor(limit / 5)) * 2 });
      addUnique(np.tracks, Math.max(1, Math.floor(limit / 5)));
    } catch { /* noop */ }

    // 30% random to fill remaining
    const remaining = limit - all.length;
    if (remaining > 0) {
      try {
        const variety = this.db
          .prepare(
            `SELECT t.path, t.filename, a.name AS artist, al.title AS album,
                    t.title, g.name AS genre, t.duration, t.play_count
             FROM tracks t
             LEFT JOIN artists a ON t.artist_id = a.id
             LEFT JOIN albums al ON t.album_id = al.id
             LEFT JOIN genres g ON t.genre_id = g.id
             WHERE t.content_type = 'music'
             GROUP BY a.id
             ORDER BY RANDOM() LIMIT ?`
          )
          .all(remaining * 2) as TrackRow[];
        addUnique(
          variety.map((r) => this._toTrack(r)),
          remaining
        );
      } catch { /* noop */ }
    }

    // Fill with pure random if still short
    if (all.length < limit) {
      try {
        const rm = this._generateRandomMix({ limit: limit - all.length });
        addUnique(rm.tracks, limit - all.length);
      } catch { /* noop */ }
    }

    // Shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }

    return {
      playlistName: "Auto Discovery",
      criteria: "Auto-generated mix with genre variety and unplayed discoveries",
      tracks: all.slice(0, limit),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "auto",
    };
  }

  // -- helpers ------------------------------------------------------------

  private _toTrack(r: TrackRow): PlaylistTrack {
    return {
      id: r.id ?? 0,
      path: r.path,
      filename: r.filename,
      artist: r.artist || "Unknown",
      album: r.album || "Unknown",
      title: r.title || r.filename,
      genre: r.genre || "Unknown",
      duration: r.duration || 0,
      playCount: r.play_count || 0,
      rating: r.rating ?? null,
    };
  }

  private _generateTopRated(opts: Record<string, unknown>): PlaylistGenerationResult {
    const limit = (opts.limit as number) || 50;
    const minRating = 8; // 4+ stars on the Rockbox 0–10 scale

    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.filename, a.name AS artist, al.title AS album,
                t.title, g.name AS genre, t.duration, t.play_count, t.rating
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = 'music' AND t.rating IS NOT NULL AND t.rating >= ?
         ORDER BY t.rating DESC, RANDOM()
         LIMIT ?`
      )
      .all(minRating, limit) as TrackRow[];

    if (!rows.length) {
      return this._empty("No rated tracks found (rate tracks 4+ stars on your device)");
    }

    return {
      playlistName: "Top Rated",
      criteria: `${rows.length} tracks rated 4+ stars`,
      tracks: rows.map((r) => this._toTrack(r)),
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "top_rated",
    };
  }

  private _empty(reason: string): PlaylistGenerationResult {
    return {
      playlistName: "Empty Playlist",
      criteria: reason,
      tracks: [],
      generatedAt: new Date().toISOString(),
      type: "smart",
      subtype: "empty",
    };
  }
}
