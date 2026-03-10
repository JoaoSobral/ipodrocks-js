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
    ? new Date(Math.min(...timestamps) * 1000).toISOString()
    : new Date().toISOString();
  const last = timestamps.length
    ? new Date(Math.max(...timestamps) * 1000).toISOString()
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
];

export function getAvailableGeniusTypes(): GeniusTypeOption[] {
  return GENIUS_TYPES;
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
        Math.max(...b.timestamps) - Math.max(...a.timestamps)
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
      "None of the played tracks in the playback log were found in your library. " +
      "Check that your library path is configured correctly.",
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
