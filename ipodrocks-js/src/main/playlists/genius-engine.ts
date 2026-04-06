import Database from "better-sqlite3";

import {
  AnalysisSummary,
  GeniusGenerateOptions,
  GeniusTypeOption,
  MatchedPlayEvent,
  PlayEvent,
  PlaylistGenerationResult,
  PlaylistTrack,
} from "../../shared/types";

// -- track matching -------------------------------------------------------

interface LibraryTrackRow {
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

/**
 * Build a case-insensitive lookup map from device-relative path fragments
 * to library track rows.
 *
 * Keys are normalised to lower-case and use ``/`` separators.
 * Multiple key variants are generated per track so that a device path
 * like ``Artist/Album/file.ext`` can match regardless of which folder
 * prefix the device prepends.
 */
function buildLibraryLookup(
  db: Database.Database
): Map<string, LibraryTrackRow> {
  const rows = db
    .prepare(
      `SELECT t.id, t.path, t.filename, t.title,
              a.name AS artist, al.title AS album,
              g.name AS genre, t.duration, t.library_folder_id
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       WHERE t.content_type = 'music'`
    )
    .all() as LibraryTrackRow[];

  const lookup = new Map<string, LibraryTrackRow>();

  for (const row of rows) {
    const fname = (row.filename ?? "").toLowerCase();
    const artist = (row.artist ?? "").trim().toLowerCase();
    const album = (row.album ?? "").trim().toLowerCase();

    if (fname) {
      lookup.set(fname, row);
    }
    if (artist && album && fname) {
      lookup.set(`${artist}/${album}/${fname}`, row);
    }
  }

  return lookup;
}

/**
 * Extract a device-relative path by stripping common Rockbox prefixes.
 *
 * Rockbox device paths look like:
 *   ``/<microSD0>/Music/Artist/Album/track.ext``
 *   ``/Music/Artist/Album/track.ext``
 *
 * We strip everything up to and including the first ``Music/``
 * (case-insensitive) segment to yield ``Artist/Album/track.ext``.
 */
function stripDevicePrefix(filePath: string): string {
  const normalised = filePath.replace(/\\/g, "/");
  const idx = normalised.toLowerCase().indexOf("/music/");
  if (idx >= 0) return normalised.slice(idx + "/music/".length);
  const parts = normalised.replace(/^\//, "").split("/");
  if (parts.length > 1) return parts.slice(1).join("/");
  return parts.join("/");
}

/**
 * Match parsed play events against the library database.
 *
 * :param events: Raw play events from the Rockbox log parser.
 * :param db: Open SQLite connection.
 * :returns: Array of matched play events with library metadata.
 */
export function matchEventsToLibrary(
  events: PlayEvent[],
  db: Database.Database
): MatchedPlayEvent[] {
  const lookup = buildLibraryLookup(db);
  const matched: MatchedPlayEvent[] = [];

  for (const ev of events) {
    const rel = stripDevicePrefix(ev.filePath).toLowerCase();
    const row = lookup.get(rel) ?? lookup.get(rel.split("/").pop() ?? "");
    if (!row) continue;

    matched.push({
      ...ev,
      trackId: row.id,
      artist: row.artist ?? "Unknown",
      album: row.album ?? "Unknown",
      title: row.title ?? row.filename,
      genre: row.genre ?? "Unknown",
      duration: row.duration ?? 0,
    });
  }

  return matched;
}

// -- analysis summary -----------------------------------------------------

/**
 * Produce a high-level summary of matched play events.
 */
export function buildAnalysisSummary(
  allEvents: PlayEvent[],
  matched: MatchedPlayEvent[]
): AnalysisSummary {
  const timestamps = allEvents.map((e) => e.timestamp).filter(Boolean);
  const first = timestamps.length
    ? new Date(timestamps.reduce((a, b) => (b < a ? b : a), Infinity) * 1000).toISOString()
    : new Date().toISOString();
  const last = timestamps.length
    ? new Date(timestamps.reduce((a, b) => (b > a ? b : a), -Infinity) * 1000).toISOString()
    : new Date().toISOString();

  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, { artist: string; count: number }>();
  const uniqueTracks = new Set<number>();

  for (const m of matched) {
    uniqueTracks.add(m.trackId);
    artistCounts.set(m.artist, (artistCounts.get(m.artist) ?? 0) + 1);

    const albumKey = `${m.artist}\0${m.album}`;
    const cur = albumCounts.get(albumKey);
    if (cur) {
      cur.count += 1;
    } else {
      albumCounts.set(albumKey, { artist: m.artist, count: 1 });
    }
  }

  let topArtist: AnalysisSummary["topArtist"] = null;
  let maxArtist = 0;
  for (const [name, count] of artistCounts) {
    if (count > maxArtist) {
      maxArtist = count;
      topArtist = { name, playCount: count };
    }
  }

  let topAlbum: AnalysisSummary["topAlbum"] = null;
  let maxAlbum = 0;
  for (const [key, val] of albumCounts) {
    if (val.count > maxAlbum) {
      maxAlbum = val.count;
      const albumName = key.split("\0")[1] ?? "Unknown";
      topAlbum = { name: albumName, artist: val.artist, playCount: val.count };
    }
  }

  return {
    totalPlays: allEvents.length,
    matchedPlays: matched.length,
    unmatchedPlays: allEvents.length - matched.length,
    dateRange: { first, last },
    topArtist,
    topAlbum,
    uniqueTracks: uniqueTracks.size,
    uniqueArtists: artistCounts.size,
  };
}

/**
 * Load MatchedPlayEvent[] from playback_logs for use with generateGeniusPlaylist.
 */
function loadMatchedEventsFromDb(
  db: Database.Database
): MatchedPlayEvent[] {
  const rows = db
    .prepare(
      `SELECT pl.timestamp_tick AS timestamp, pl.elapsed_ms AS elapsedMs,
              pl.total_ms AS totalMs, pl.file_path AS filePath,
              pl.completion_rate AS completionRatio, pl.matched_track_id AS trackId,
              a.name AS artist, al.title AS album, t.title AS trackTitle,
              g.name AS genre, t.duration
       FROM playback_logs pl
       JOIN tracks t ON t.id = pl.matched_track_id AND t.content_type = 'music'
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       WHERE pl.matched_track_id IS NOT NULL`
    )
    .all() as Array<{
    timestamp: number;
    elapsedMs: number;
    totalMs: number;
    filePath: string;
    completionRatio: number;
    trackId: number;
    artist: string | null;
    album: string | null;
    trackTitle: string | null;
    genre: string | null;
    duration: number | null;
  }>;

  return rows.map((r) => ({
    timestamp: r.timestamp,
    elapsedMs: r.elapsedMs,
    totalMs: r.totalMs,
    filePath: r.filePath,
    completionRatio: r.completionRatio,
    trackId: r.trackId,
    artist: r.artist ?? "Unknown",
    album: r.album ?? "Unknown",
    title: r.trackTitle ?? "Unknown",
    genre: r.genre ?? "Unknown",
    duration: r.duration ?? 0,
  }));
}

/**
 * Build AnalysisSummary from playback_stats and playback_logs in the database.
 * Returns empty summary if no playback data exists.
 */
export function buildAnalysisSummaryFromDb(
  db: Database.Database
): AnalysisSummary {
  const totalRow = db
    .prepare(
      "SELECT COUNT(*) as c, MIN(timestamp_tick) as first_ts, MAX(timestamp_tick) as last_ts " +
        "FROM playback_logs WHERE matched_track_id IS NOT NULL"
    )
    .get() as { c: number; first_ts: number | null; last_ts: number | null };

  const totalPlays = totalRow.c ?? 0;
  const first =
    totalRow.first_ts != null
      ? new Date(totalRow.first_ts * 1000).toISOString()
      : new Date().toISOString();
  const last =
    totalRow.last_ts != null
      ? new Date(totalRow.last_ts * 1000).toISOString()
      : new Date().toISOString();

  if (totalPlays === 0) {
    return {
      totalPlays: 0,
      matchedPlays: 0,
      unmatchedPlays: 0,
      dateRange: { first, last },
      topArtist: null,
      topAlbum: null,
      uniqueTracks: 0,
      uniqueArtists: 0,
    };
  }

  const artistRows = db
    .prepare(
      `SELECT a.name, SUM(ps.total_plays) as plays
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
       LEFT JOIN artists a ON t.artist_id = a.id
       GROUP BY a.id
       ORDER BY plays DESC`
    )
    .all() as Array<{ name: string | null; plays: number }>;

  const albumRows = db
    .prepare(
      `SELECT al.title as album, a.name as artist, SUM(ps.total_plays) as plays
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       GROUP BY al.id, a.id
       ORDER BY plays DESC`
    )
    .all() as Array<{ album: string | null; artist: string | null; plays: number }>;

  const topArtist =
    artistRows.length > 0 && artistRows[0].plays > 0
      ? {
          name: artistRows[0].name ?? "Unknown",
          playCount: artistRows[0].plays,
        }
      : null;

  const topAlbum =
    albumRows.length > 0 && albumRows[0].plays > 0
      ? {
          name: albumRows[0].album ?? "Unknown",
          artist: albumRows[0].artist ?? "Unknown",
          playCount: albumRows[0].plays,
        }
      : null;

  const uniqueRow = db
    .prepare(
      "SELECT COUNT(DISTINCT track_id) as tracks, COUNT(DISTINCT t.artist_id) as artists " +
        "FROM playback_stats ps JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'"
    )
    .get() as { tracks: number; artists: number };

  return {
    totalPlays,
    matchedPlays: totalPlays,
    unmatchedPlays: 0,
    dateRange: { first, last },
    topArtist,
    topAlbum,
    uniqueTracks: uniqueRow.tracks ?? 0,
    uniqueArtists: uniqueRow.artists ?? 0,
  };
}

// -- available genius types -----------------------------------------------

const GENIUS_TYPES: GeniusTypeOption[] = [
  {
    value: "most_played",
    label: "Most Played",
    description: "Top tracks by total play count",
    icon: "\uD83D\uDD25",
  },
  {
    value: "favorites",
    label: "Favorites (High Completion)",
    description:
      "Tracks with avg completion \u2265 85%, played at least twice",
    icon: "\u2705",
  },
  {
    value: "skip_list",
    label: "Skip List",
    description:
      "Tracks with avg completion < 25% \u2014 songs you always skip",
    icon: "\u23ED\uFE0F",
  },
  {
    value: "top_artist",
    label: "Top Artist",
    description: "All library tracks by your most-played artist",
    icon: "\uD83C\uDFA4",
  },
  {
    value: "top_album",
    label: "Top Album",
    description: "All library tracks from your most-played album",
    icon: "\uD83D\uDCBF",
  },
  {
    value: "late_night",
    label: "Late Night Mood",
    description:
      "Tracks played between 22:00\u201305:00 with high completion",
    icon: "\uD83C\uDF19",
  },
  {
    value: "recently_discovered",
    label: "Recently Discovered",
    description:
      "Tracks played only once, completed > 80% \u2014 things you tried and liked",
    icon: "\uD83C\uDD95",
  },
  {
    value: "deep_dive",
    label: "Deep Dive (Artist)",
    description:
      "Pick an artist and get all their library tracks ordered by play count",
    icon: "\uD83D\uDD01",
  },
  {
    value: "oldies",
    label: "Oldies",
    description: "Tracks first played 36+ months ago, ordered by play count",
    icon: "\uD83C\uDFB5",
    minMonths: 36,
  },
  {
    value: "nostalgia",
    label: "Nostalgia",
    description: "First played 12\u201336 months ago, ordered by play count",
    icon: "\uD83C\uDFA7",
    minMonths: 12,
  },
  {
    value: "recent_favorites",
    label: "Recent Favorites",
    description: "Last played in last 6 months with high completion",
    icon: "\uD83D\uDC9C",
    minMonths: 6,
  },
  {
    value: "time_capsule",
    label: "Time Capsule",
    description: "Tracks from a specific month/year you pick",
    icon: "\u23F0",
    minMonths: 24,
  },
  {
    value: "golden_era",
    label: "Golden Era",
    description: "Most played in a time range (e.g. 24\u201348 months ago)",
    icon: "\uD83C\uDFC6",
    minMonths: 24,
  },
];

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Get approximate months of playback data (from earliest to now).
 */
export function getPlaybackDataMonths(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT MIN(timestamp_tick) as min_ts FROM playback_logs WHERE matched_track_id IS NOT NULL"
    )
    .get() as { min_ts: number | null };
  if (row.min_ts == null) return 0;
  const now = Math.floor(Date.now() / 1000);
  const months = (now - row.min_ts) * 1000 / MS_PER_MONTH;
  return Math.max(0, Math.floor(months));
}

export function getAvailableGeniusTypes(
  db?: Database.Database
): GeniusTypeOption[] {
  const dataMonths = db ? getPlaybackDataMonths(db) : 0;
  return GENIUS_TYPES.filter(
    (t) => t.minMonths == null || dataMonths >= t.minMonths
  );
}

// -- playlist generation --------------------------------------------------

/**
 * Aggregate per-track stats from matched events.
 */
interface TrackAggregation {
  trackId: number;
  artist: string;
  album: string;
  title: string;
  genre: string;
  duration: number;
  playCount: number;
  completionRatios: number[];
  timestamps: number[];
}

function aggregateByTrack(
  events: MatchedPlayEvent[]
): Map<number, TrackAggregation> {
  const agg = new Map<number, TrackAggregation>();
  for (const ev of events) {
    let entry = agg.get(ev.trackId);
    if (!entry) {
      entry = {
        trackId: ev.trackId,
        artist: ev.artist,
        album: ev.album,
        title: ev.title,
        genre: ev.genre,
        duration: ev.duration,
        playCount: 0,
        completionRatios: [],
        timestamps: [],
      };
      agg.set(ev.trackId, entry);
    }
    entry.playCount += 1;
    entry.completionRatios.push(ev.completionRatio);
    entry.timestamps.push(ev.timestamp);
  }
  return agg;
}

function avgCompletion(ratios: number[]): number {
  if (!ratios.length) return 0;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function aggToTrack(a: TrackAggregation): PlaylistTrack {
  return {
    id: a.trackId,
    path: "",
    filename: "",
    title: a.title,
    artist: a.artist,
    album: a.album,
    genre: a.genre,
    duration: a.duration,
    playCount: a.playCount,
    avgCompletionRate: avgCompletion(a.completionRatios),
  };
}

/**
 * Fetch all library tracks for a given artist name.
 */
function getLibraryTracksByArtist(
  db: Database.Database,
  artistName: string
): PlaylistTrack[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.path, t.filename, t.title,
              a.name AS artist, al.title AS album,
              g.name AS genre, t.duration, t.play_count
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       WHERE a.name = ? AND t.content_type = 'music'
       ORDER BY t.title`
    )
    .all(artistName) as Array<{
    id: number;
    path: string;
    filename: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    duration: number | null;
    play_count: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title ?? r.filename,
    artist: r.artist ?? "Unknown",
    album: r.album ?? "Unknown",
    genre: r.genre ?? "Unknown",
    duration: r.duration ?? 0,
    playCount: r.play_count ?? 0,
  }));
}

/**
 * Fetch all library tracks for a given album title + artist name.
 */
function getLibraryTracksByAlbum(
  db: Database.Database,
  albumTitle: string,
  artistName: string
): PlaylistTrack[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.path, t.filename, t.title,
              a.name AS artist, al.title AS album,
              g.name AS genre, t.duration, t.play_count
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       WHERE al.title = ? AND a.name = ? AND t.content_type = 'music'
       ORDER BY t.track_number, t.title`
    )
    .all(albumTitle, artistName) as Array<{
    id: number;
    path: string;
    filename: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    duration: number | null;
    play_count: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title ?? r.filename,
    artist: r.artist ?? "Unknown",
    album: r.album ?? "Unknown",
    genre: r.genre ?? "Unknown",
    duration: r.duration ?? 0,
    playCount: r.play_count ?? 0,
  }));
}

// -- the 8 algorithms -----------------------------------------------------

function generateMostPlayed(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const minPlays = opts.minPlays ?? 1;
  const agg = aggregateByTrack(events);

  const tracks = [...agg.values()]
    .filter((a) => a.playCount >= minPlays)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit)
    .map(aggToTrack);

  return {
    playlistName: "Most Played",
    criteria: `Top ${tracks.length} tracks by play count (min ${minPlays})`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "most_played",
  };
}

function generateFavorites(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const minPlays = opts.minPlays ?? 2;
  const agg = aggregateByTrack(events);

  const tracks = [...agg.values()]
    .filter(
      (a) =>
        a.playCount >= minPlays &&
        avgCompletion(a.completionRatios) >= 0.85
    )
    .sort(
      (a, b) =>
        avgCompletion(b.completionRatios) -
        avgCompletion(a.completionRatios)
    )
    .slice(0, limit)
    .map(aggToTrack);

  return {
    playlistName: "Favorites (High Completion)",
    criteria:
      `${tracks.length} tracks with avg completion >= 85% ` +
      `and at least ${minPlays} plays`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "favorites",
  };
}

function generateSkipList(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const agg = aggregateByTrack(events);

  const tracks = [...agg.values()]
    .filter((a) => avgCompletion(a.completionRatios) < 0.25)
    .sort(
      (a, b) =>
        avgCompletion(a.completionRatios) -
        avgCompletion(b.completionRatios)
    )
    .slice(0, limit)
    .map(aggToTrack);

  return {
    playlistName: "Skip List",
    criteria:
      `${tracks.length} tracks with avg completion < 25%`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "skip_list",
  };
}

function generateTopArtist(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const artistCounts = new Map<string, number>();
  for (const ev of events) {
    artistCounts.set(ev.artist, (artistCounts.get(ev.artist) ?? 0) + 1);
  }

  let topName = "";
  let topCount = 0;
  for (const [name, count] of artistCounts) {
    if (count > topCount) {
      topCount = count;
      topName = name;
    }
  }

  if (!topName) {
    return emptyResult("No artist data in playback log", "top_artist");
  }

  const tracks = getLibraryTracksByArtist(db, topName).slice(0, limit);

  return {
    playlistName: `Top Artist: ${topName}`,
    criteria: `All library tracks by ${topName} (${topCount} plays)`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_artist",
  };
}

function generateTopAlbum(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const albumCounts = new Map<
    string,
    { album: string; artist: string; count: number }
  >();

  for (const ev of events) {
    const key = `${ev.artist}\0${ev.album}`;
    const cur = albumCounts.get(key);
    if (cur) {
      cur.count += 1;
    } else {
      albumCounts.set(key, {
        album: ev.album,
        artist: ev.artist,
        count: 1,
      });
    }
  }

  let topEntry: { album: string; artist: string; count: number } | null =
    null;
  for (const val of albumCounts.values()) {
    if (!topEntry || val.count > topEntry.count) topEntry = val;
  }

  if (!topEntry) {
    return emptyResult("No album data in playback log", "top_album");
  }

  const tracks = getLibraryTracksByAlbum(
    db,
    topEntry.album,
    topEntry.artist
  ).slice(0, limit);

  return {
    playlistName: `Top Album: ${topEntry.album}`,
    criteria:
      `All library tracks from ${topEntry.album} ` +
      `by ${topEntry.artist} (${topEntry.count} plays)`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_album",
  };
}

function generateLateNight(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const agg = aggregateByTrack(
    events.filter((ev) => {
      const hour = new Date(ev.timestamp * 1000).getHours();
      return hour >= 22 || hour < 5;
    })
  );

  const tracks = [...agg.values()]
    .filter((a) => avgCompletion(a.completionRatios) >= 0.6)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit)
    .map(aggToTrack);

  return {
    playlistName: "Late Night Mood",
    criteria:
      `${tracks.length} tracks played between 22:00\u201305:00 ` +
      "with high completion",
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "late_night",
  };
}

function generateRecentlyDiscovered(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const agg = aggregateByTrack(events);

  const tracks = [...agg.values()]
    .filter(
      (a) =>
        a.playCount === 1 &&
        avgCompletion(a.completionRatios) > 0.8
    )
    .sort(
      (a, b) =>
        b.timestamps.reduce((x, y) => (y > x ? y : x), -Infinity) -
        a.timestamps.reduce((x, y) => (y > x ? y : x), -Infinity)
    )
    .slice(0, limit)
    .map(aggToTrack);

  return {
    playlistName: "Recently Discovered",
    criteria:
      `${tracks.length} tracks played once and completed > 80%`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "recently_discovered",
  };
}

function generateOldies(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - 36 * 30 * 24 * 3600;
  const agg = aggregateByTrack(events);
  const filtered = [...agg.values()].filter((a) => {
    const firstTs = a.timestamps.reduce((x, y) => (y < x ? y : x), Infinity);
    return firstTs < cutoffSec;
  });
  const tracks = filtered
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit)
    .map(aggToTrack);
  return {
    playlistName: "Oldies",
    criteria: "Tracks first played 36+ months ago, by play count",
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "oldies",
  };
}

function generateNostalgia(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - 36 * 30 * 24 * 3600;
  const endSec = nowSec - 12 * 30 * 24 * 3600;
  const agg = aggregateByTrack(events);
  const filtered = [...agg.values()].filter((a) => {
    const firstTs = a.timestamps.reduce((x, y) => (y < x ? y : x), Infinity);
    return firstTs >= endSec && firstTs < startSec;
  });
  const tracks = filtered
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit)
    .map(aggToTrack);
  return {
    playlistName: "Nostalgia",
    criteria: "First played 12\u201336 months ago, by play count",
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "nostalgia",
  };
}

function generateRecentFavorites(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - 6 * 30 * 24 * 3600;
  const agg = aggregateByTrack(events);
  const filtered = [...agg.values()].filter((a) => {
    const lastTs = a.timestamps.reduce((x, y) => (y > x ? y : x), -Infinity);
    const avgComp = avgCompletion(a.completionRatios);
    return lastTs >= cutoffSec && avgComp >= 0.85;
  });
  const tracks = filtered
    .sort(
      (a, b) =>
        avgCompletion(b.completionRatios) - avgCompletion(a.completionRatios)
    )
    .slice(0, limit)
    .map(aggToTrack);
  return {
    playlistName: "Recent Favorites",
    criteria: "Last played in last 6 months, avg completion \u2265 85%",
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "recent_favorites",
  };
}

function generateTimeCapsule(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const targetMonth = opts.targetMonth ?? 1;
  const targetYear = opts.targetYear ?? new Date().getFullYear();
  const startDate = new Date(targetYear, targetMonth - 1, 1);
  const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59);
  const startSec = Math.floor(startDate.getTime() / 1000);
  const endSec = Math.floor(endDate.getTime() / 1000);
  const inRange = (ts: number) => ts >= startSec && ts <= endSec;
  const agg = aggregateByTrack(events);
  const filtered = [...agg.values()].filter((a) =>
    a.timestamps.some(inRange)
  );
  const tracks = filtered
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit)
    .map(aggToTrack);
  const monthName = startDate.toLocaleString("default", { month: "long" });
  return {
    playlistName: `Time Capsule: ${monthName} ${targetYear}`,
    criteria: `Tracks played in ${monthName} ${targetYear}`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "time_capsule",
  };
}

function generateGoldenEra(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const endMonths = opts.rangeEndMonthsAgo ?? 24;
  const startMonths = opts.rangeStartMonthsAgo ?? 48;
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - startMonths * 30 * 24 * 3600;
  const endSec = nowSec - endMonths * 30 * 24 * 3600;
  const inRange = (ts: number) => ts >= startSec && ts <= endSec;
  const agg = aggregateByTrack(events);
  const playCountInRange = new Map<number, number>();
  for (const a of agg.values()) {
    const count = a.timestamps.filter(inRange).length;
    if (count > 0) {
      playCountInRange.set(a.trackId, count);
    }
  }
  const filtered = [...agg.values()].filter((a) =>
    playCountInRange.has(a.trackId)
  );
  const tracks = filtered
    .sort(
      (a, b) =>
        (playCountInRange.get(b.trackId) ?? 0) -
        (playCountInRange.get(a.trackId) ?? 0)
    )
    .slice(0, limit)
    .map(aggToTrack);
  return {
    playlistName: "Golden Era",
    criteria: `Most played ${endMonths}\u2013${startMonths} months ago`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "golden_era",
  };
}

function generateDeepDive(
  events: MatchedPlayEvent[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const artistName = opts.artist;

  if (!artistName) {
    return emptyResult(
      "No artist selected for Deep Dive",
      "deep_dive"
    );
  }

  const agg = aggregateByTrack(
    events.filter(
      (ev) => ev.artist.toLowerCase() === artistName.toLowerCase()
    )
  );
  const playCountMap = new Map<number, number>();
  for (const a of agg.values()) {
    playCountMap.set(a.trackId, a.playCount);
  }

  const allTracks = getLibraryTracksByArtist(db, artistName);
  allTracks.sort(
    (a, b) =>
      (playCountMap.get(b.id) ?? 0) - (playCountMap.get(a.id) ?? 0)
  );

  const tracks = allTracks.slice(0, limit).map((t) => ({
    ...t,
    playCount: playCountMap.get(t.id) ?? 0,
  }));

  return {
    playlistName: `Deep Dive: ${artistName}`,
    criteria:
      `All library tracks by ${artistName} ordered by play count`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "deep_dive",
  };
}

// -- public generator entry point -----------------------------------------

function emptyResult(
  reason: string,
  subtype: string
): PlaylistGenerationResult {
  return {
    playlistName: "Empty Playlist",
    criteria: reason,
    tracks: [],
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype,
  };
}

/**
 * Generate a genius playlist from playback_logs in the database.
 * Use when device is not connected or when using DB-backed Genius.
 */
export function generateGeniusPlaylistFromDb(
  geniusType: string,
  db: Database.Database,
  opts: GeniusGenerateOptions = {}
): PlaylistGenerationResult {
  const events = loadMatchedEventsFromDb(db);
  return generateGeniusPlaylist(geniusType, events, db, opts);
}

/**
 * Generate a genius playlist from in-memory matched events.
 *
 * :param geniusType: One of the 8 algorithm keys.
 * :param events: Matched play events (from ``matchEventsToLibrary``).
 * :param db: Open SQLite connection (for library queries).
 * :param opts: User-configurable generation options.
 * :returns: A PlaylistGenerationResult with the track preview.
 */
export function generateGeniusPlaylist(
  geniusType: string,
  events: MatchedPlayEvent[],
  db: Database.Database,
  opts: GeniusGenerateOptions = {}
): PlaylistGenerationResult {
  if (!events.length) {
    return emptyResult(
      "No playback history in database. Connect a device and recheck for " +
        "playback.log data, or run a sync/device check.",
      geniusType
    );
  }

  switch (geniusType) {
    case "most_played":
      return generateMostPlayed(events, opts);
    case "favorites":
      return generateFavorites(events, opts);
    case "skip_list":
      return generateSkipList(events, opts);
    case "top_artist":
      return generateTopArtist(events, opts, db);
    case "top_album":
      return generateTopAlbum(events, opts, db);
    case "late_night":
      return generateLateNight(events, opts);
    case "recently_discovered":
      return generateRecentlyDiscovered(events, opts);
    case "deep_dive":
      return generateDeepDive(events, opts, db);
    case "oldies":
      return generateOldies(events, opts, db);
    case "nostalgia":
      return generateNostalgia(events, opts, db);
    case "recent_favorites":
      return generateRecentFavorites(events, opts);
    case "time_capsule":
      return generateTimeCapsule(events, opts);
    case "golden_era":
      return generateGoldenEra(events, opts);
    default:
      throw new Error(`Unknown genius playlist type: ${geniusType}`);
  }
}

/**
 * Return a list of unique artist names present in the matched events,
 * sorted by play count descending.  Used for the Deep Dive artist picker.
 */
export function getArtistsFromEvents(
  events: MatchedPlayEvent[]
): Array<{ name: string; playCount: number }> {
  const counts = new Map<string, number>();
  for (const ev of events) {
    counts.set(ev.artist, (counts.get(ev.artist) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, playCount]) => ({ name, playCount }))
    .sort((a, b) => b.playCount - a.playCount);
}

/**
 * Return artists from playback_stats, sorted by play count descending.
 * Used for the Deep Dive artist picker when using DB-backed Genius.
 */
export function getArtistsFromPlaybackStats(
  db: Database.Database
): Array<{ name: string; playCount: number }> {
  const rows = db
    .prepare(
      `SELECT a.name, SUM(ps.total_plays) as plays
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE a.name IS NOT NULL AND a.name != ''
       GROUP BY a.id
       ORDER BY plays DESC`
    )
    .all() as Array<{ name: string; plays: number }>;
  return rows.map((r) => ({ name: r.name, playCount: r.plays }));
}
