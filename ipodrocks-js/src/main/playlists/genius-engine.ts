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
  rating: number | null;
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
              g.name AS genre, t.duration, t.library_folder_id, t.rating
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
      rating: row.rating ?? null,
    });
  }

  return matched;
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
              g.name AS genre, t.duration, t.rating
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
    rating: number | null;
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
    rating: r.rating ?? null,
  }));
}

/**
 * Build AnalysisSummary from playback_stats and playback_logs in the database.
 * Returns empty summary if no playback data exists.
 */
export function buildAnalysisSummaryFromDb(
  db: Database.Database
): AnalysisSummary {
  const nowSec = Math.floor(Date.now() / 1000);
  // Bound the range to plausible timestamps so a device with an unset clock
  // does not report a listening history that starts in the year 2000.
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as c,
              MIN(CASE WHEN timestamp_tick >= ? AND timestamp_tick <= ?
                       THEN timestamp_tick END) as first_ts,
              MAX(CASE WHEN timestamp_tick >= ? AND timestamp_tick <= ?
                       THEN timestamp_tick END) as last_ts
       FROM playback_logs WHERE matched_track_id IS NOT NULL`
    )
    .get(
      MIN_PLAUSIBLE_TS,
      nowSec + FUTURE_SLACK_SEC,
      MIN_PLAUSIBLE_TS,
      nowSec + FUTURE_SLACK_SEC
    ) as { c: number; first_ts: number | null; last_ts: number | null };

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
    value: "top_rated",
    label: "Top Rated",
    description: "Tracks you've rated 4+ stars, ordered by rating then play count",
    icon: "\u2B50",
  },
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
    requiresDeviceClock: true,
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
    value: "hidden_gems",
    label: "Hidden Gems",
    description: "Tracks in your library you have never played",
    icon: "\uD83D\uDC8E",
  },
  {
    value: "top_genre",
    label: "Top Genre",
    description: "All library tracks in your most-played genre",
    icon: "\uD83C\uDFB8",
  },
  {
    value: "finish_album",
    label: "Finish the Album",
    description:
      "Tracks you have not heard from albums you started but never finished",
    icon: "\uD83D\uDCC0",
  },
];

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Earliest timestamp we treat as a real play.
 *
 * Rockbox reads the play time off the device RTC, which starts at (or resets
 * to) the year 2000 whenever the clock is unset or the battery fully drains.
 * Anything before 2010 is a clock that was never set, not a real listen.
 */
const MIN_PLAUSIBLE_TS = Math.floor(Date.UTC(2010, 0, 1) / 1000);

/**
 * How far ahead of the host clock a device timestamp may legitimately sit.
 *
 * Rockbox writes device *local* wall-clock time as a UTC epoch, so a device
 * set to a far-eastern timezone reads genuinely ahead of true UTC. One day of
 * slack covers every real offset \u2014 do not tighten this to ``now``.
 */
const FUTURE_SLACK_SEC = 24 * 60 * 60;

/** Minimum plausible rows before we trust the device clock at all. */
const MIN_PLAUSIBLE_ROWS = 20;

/** Fraction of rows that must be plausible before we trust the clock. */
const MIN_PLAUSIBLE_FRACTION = 0.5;

/** Whether a raw device timestamp (epoch seconds) looks like a real play. */
function isPlausibleTimestamp(tsSec: number, nowSec: number): boolean {
  return tsSec >= MIN_PLAUSIBLE_TS && tsSec <= nowSec + FUTURE_SLACK_SEC;
}

/** Playback-data context, including how trustworthy the device clock looks. */
export interface PlaybackClockContext {
  /** Approximate months spanned by the *plausible* rows (0 when none). */
  dataMonths: number;
  /** ISO date of the earliest *plausible* matched row, or null. */
  firstLogDate: string | null;
  /** Matched rows, regardless of timestamp plausibility. */
  totalMatched: number;
  /** Matched rows with a plausible timestamp. */
  plausibleCount: number;
  /** Matched rows with an implausible timestamp. */
  implausibleCount: number;
  /** Whether the device clock looks correctly set. */
  clockValid: boolean;
}

/**
 * Classify the playback log by timestamp plausibility.
 *
 * ``dataMonths``/``firstLogDate`` are derived from plausible rows only, so a
 * device with an unset clock does not appear to have decades of history.
 * ``totalMatched`` counts every matched row, so callers can still tell the
 * difference between "no plays recorded" and "plays recorded under a bad
 * clock" — never key user-facing copy off ``dataMonths`` alone.
 */
export function getPlaybackDataContext(
  db: Database.Database
): PlaybackClockContext {
  const nowSec = Math.floor(Date.now() / 1000);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN timestamp_tick >= ? AND timestamp_tick <= ?
                       THEN 1 ELSE 0 END) AS plausible,
              MIN(CASE WHEN timestamp_tick >= ? AND timestamp_tick <= ?
                       THEN timestamp_tick END) AS min_valid_ts
       FROM playback_logs
       WHERE matched_track_id IS NOT NULL`
    )
    .get(
      MIN_PLAUSIBLE_TS,
      nowSec + FUTURE_SLACK_SEC,
      MIN_PLAUSIBLE_TS,
      nowSec + FUTURE_SLACK_SEC
    ) as {
    total: number;
    plausible: number | null;
    min_valid_ts: number | null;
  };

  const totalMatched = row.total ?? 0;
  const plausibleCount = row.plausible ?? 0;
  const implausibleCount = totalMatched - plausibleCount;

  // Mirrors the mass-zero rating guard in sync/rating-merge.ts: require both a
  // floor and a majority so one stray good row cannot vouch for the clock.
  const clockValid =
    plausibleCount >= MIN_PLAUSIBLE_ROWS &&
    plausibleCount / totalMatched >= MIN_PLAUSIBLE_FRACTION;

  const dataMonths =
    row.min_valid_ts == null
      ? 0
      : Math.max(
          0,
          Math.floor(((nowSec - row.min_valid_ts) * 1000) / MS_PER_MONTH)
        );

  return {
    dataMonths,
    firstLogDate:
      row.min_valid_ts == null
        ? null
        : new Date(row.min_valid_ts * 1000).toISOString(),
    totalMatched,
    plausibleCount,
    implausibleCount,
    clockValid,
  };
}

/**
 * Get approximate months of trustworthy playback data (earliest to now).
 */
export function getPlaybackDataMonths(db: Database.Database): number {
  return getPlaybackDataContext(db).dataMonths;
}

/** Reason shown when a clock-dependent type cannot run. */
function deviceClockReason(ctx: PlaybackClockContext): string {
  if (ctx.totalMatched === 0) {
    return "No playback history yet — connect your device and check for playback.log data.";
  }
  return (
    "Your device clock is not set correctly, so times of day are unreliable. " +
    "Set it in Rockbox under Settings → General Settings → System → Time & Date, " +
    "then play some music and re-check the device."
  );
}

/**
 * Annotate every genius type with whether it can currently produce a
 * meaningful result, alongside the shared playback/clock context so the UI can
 * explain any that are disabled.
 */
function annotateGeniusTypes(db: Database.Database): {
  types: GeniusTypeOption[];
} & PlaybackClockContext {
  const ctx = getPlaybackDataContext(db);
  const types = GENIUS_TYPES.map((t) => {
    const available = !t.requiresDeviceClock || ctx.clockValid;
    return available
      ? { ...t, available: true }
      : { ...t, available: false, unavailableReason: deviceClockReason(ctx) };
  });
  return { types, ...ctx };
}

/**
 * Every genius type, including unavailable ones (the UI disables rather than
 * hides them), plus the playback/clock context behind that decision.
 */
export function getGeniusTypesWithAvailability(db: Database.Database): {
  types: GeniusTypeOption[];
} & PlaybackClockContext {
  return annotateGeniusTypes(db);
}

/** Only the genius types that can run right now. */
export function getAvailableGeniusTypes(
  db: Database.Database
): GeniusTypeOption[] {
  return annotateGeniusTypes(db).types.filter((t) => t.available !== false);
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
  rating: number | null;
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
        rating: ev.rating,
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
    rating: a.rating ?? null,
    playCount: a.playCount,
    avgCompletionRate: avgCompletion(a.completionRatios),
  };
}

/**
 * Shared column list for library-track lookups.
 *
 * Play counts come from ``playback_stats.total_plays``, never from
 * ``tracks.play_count`` — that column exists in the schema but is never
 * written, so reading it reports every track as unplayed.
 */
const LIB_TRACK_SELECT = `
  SELECT t.id, t.path, t.filename, t.title, t.track_number, t.disc_number,
         a.name AS artist, al.title AS album, g.name AS genre,
         t.duration, t.rating,
         COALESCE(ps.total_plays, 0) AS play_count
  FROM tracks t
  LEFT JOIN artists a ON t.artist_id = a.id
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN genres g ON t.genre_id = g.id
  LEFT JOIN playback_stats ps ON ps.track_id = t.id
`;

interface LibTrackRow {
  id: number;
  path: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  duration: number | null;
  play_count: number | null;
  rating: number | null;
}

function rowToPlaylistTrack(r: LibTrackRow): PlaylistTrack {
  return {
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title ?? r.filename,
    artist: r.artist ?? "Unknown",
    album: r.album ?? "Unknown",
    genre: r.genre ?? "Unknown",
    duration: r.duration ?? 0,
    playCount: r.play_count ?? 0,
    rating: r.rating ?? null,
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
      `${LIB_TRACK_SELECT}
       WHERE a.name = ? AND t.content_type = 'music'
       ORDER BY t.title`
    )
    .all(artistName) as LibTrackRow[];
  return rows.map(rowToPlaylistTrack);
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
      `${LIB_TRACK_SELECT}
       WHERE al.title = ? AND a.name = ? AND t.content_type = 'music'
       ORDER BY t.track_number, t.title`
    )
    .all(albumTitle, artistName) as LibTrackRow[];
  return rows.map(rowToPlaylistTrack);
}

/**
 * Fetch all library tracks for a given genre id, most-played first.
 */
function getLibraryTracksByGenre(
  db: Database.Database,
  genreId: number
): PlaylistTrack[] {
  const rows = db
    .prepare(
      `${LIB_TRACK_SELECT}
       WHERE t.genre_id = ? AND t.content_type = 'music'
       ORDER BY play_count DESC, a.name, al.title,
                t.disc_number, t.track_number`
    )
    .all(genreId) as LibTrackRow[];
  return rows.map(rowToPlaylistTrack);
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
  const nowSec = Math.floor(Date.now() / 1000);
  const agg = aggregateByTrack(
    events.filter((ev) => {
      // This is the only generator that reads an absolute wall-clock hour, so
      // it is also the only one that must drop rows logged under an unset
      // device clock. Do not push this filter up into the shared event load —
      // the count/completion-based types stay correct under a wrong clock.
      if (!isPlausibleTimestamp(ev.timestamp, nowSec)) return false;
      // Rockbox writes device local wall-clock time as a UTC epoch, so read
      // the hour back with UTC accessors to recover the device-local hour.
      const hour = new Date(ev.timestamp * 1000).getUTCHours();
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

// -- top_rated / hidden_gems: DB-driven, no play history required ---------

function generateTopRated(
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const minRating = 8; // 4+ stars on the Rockbox 0–10 scale

  const rows = db
    .prepare(
      `${LIB_TRACK_SELECT}
       WHERE t.content_type = 'music' AND t.rating IS NOT NULL AND t.rating >= ?
       ORDER BY t.rating DESC, play_count DESC
       LIMIT ?`
    )
    .all(minRating, limit) as LibTrackRow[];

  const tracks = rows.map(rowToPlaylistTrack);

  return {
    playlistName: "Top Rated",
    criteria: `${tracks.length} tracks rated 4+ stars, by rating then play count`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_rated",
  };
}

/**
 * Library tracks that have never been played.
 *
 * Membership is tested against ``playback_logs`` rather than
 * ``playback_stats``: the stats table is rebuilt with ``INSERT OR REPLACE``
 * and never prunes, so it can lag the log. Rating-first ordering surfaces
 * music the user already liked enough to rate but never got round to, and the
 * ``RANDOM()`` tiebreak stops the result being alphabetical by artist.
 */
function generateHiddenGems(
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const rows = db
    .prepare(
      `${LIB_TRACK_SELECT}
       WHERE t.content_type = 'music'
         AND NOT EXISTS (
           SELECT 1 FROM playback_logs pl WHERE pl.matched_track_id = t.id
         )
       ORDER BY (t.rating IS NULL), t.rating DESC, RANDOM()
       LIMIT ?`
    )
    .all(limit) as LibTrackRow[];

  const tracks = rows.map(rowToPlaylistTrack);

  return {
    playlistName: "Hidden Gems",
    criteria: `${tracks.length} tracks from your library you have never played`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "hidden_gems",
  };
}

/**
 * All library tracks in the most-played genre.
 *
 * The winner is picked in SQL with an inner join on ``genres`` so untagged
 * tracks cannot win the vote — unlike the string-keyed top_artist/top_album
 * tallies, which can crown a literal "Unknown".
 */
function generateTopGenre(
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const top = db
    .prepare(
      `SELECT t.genre_id AS gid, g.name AS name, COUNT(*) AS plays
       FROM playback_logs pl
       JOIN tracks t ON t.id = pl.matched_track_id AND t.content_type = 'music'
       JOIN genres g ON g.id = t.genre_id
       GROUP BY t.genre_id
       ORDER BY plays DESC, g.name
       LIMIT 1`
    )
    .get() as { gid: number; name: string; plays: number } | undefined;

  if (!top) {
    return emptyResult("No genre data in playback log", "top_genre");
  }

  const tracks = getLibraryTracksByGenre(db, top.gid).slice(0, limit);

  return {
    playlistName: `Top Genre: ${top.name}`,
    criteria: `All library tracks tagged ${top.name} (${top.plays} plays)`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_genre",
  };
}

/**
 * Unplayed tracks from albums that were started but never finished, ordered
 * closest-to-complete first.
 *
 * ``album_id IS NOT NULL`` is essential: the column is nullable, and without
 * the guard every album-less track collapses into one giant bogus "album"
 * that dominates the result. The ``total_tracks >= 3`` floor keeps out noise —
 * including compilations, which ``albums UNIQUE(title, artist_id)`` splits
 * into one-track rows when each track carries a different artist.
 */
function generateFinishAlbum(
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const rows = db
    .prepare(
      `WITH album_progress AS (
         SELECT t.album_id AS album_id,
                COUNT(*) AS total_tracks,
                SUM(CASE WHEN EXISTS (
                      SELECT 1 FROM playback_logs pl
                      WHERE pl.matched_track_id = t.id
                    ) THEN 1 ELSE 0 END) AS played_tracks
         FROM tracks t
         WHERE t.content_type = 'music' AND t.album_id IS NOT NULL
         GROUP BY t.album_id
       )
       SELECT t.id, t.path, t.filename, t.title, t.track_number, t.disc_number,
              a.name AS artist, al.title AS album, g.name AS genre,
              t.duration, t.rating,
              COALESCE(ps.total_plays, 0) AS play_count
       FROM tracks t
       JOIN album_progress ap ON ap.album_id = t.album_id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       LEFT JOIN playback_stats ps ON ps.track_id = t.id
       WHERE t.content_type = 'music'
         AND ap.played_tracks > 0
         AND ap.played_tracks < ap.total_tracks
         AND ap.total_tracks >= 3
         AND NOT EXISTS (
           SELECT 1 FROM playback_logs pl WHERE pl.matched_track_id = t.id
         )
       ORDER BY (CAST(ap.played_tracks AS REAL) / ap.total_tracks) DESC,
                al.title, t.disc_number, t.track_number
       LIMIT ?`
    )
    .all(limit) as LibTrackRow[];

  const tracks = rows.map(rowToPlaylistTrack);

  return {
    playlistName: "Finish the Album",
    criteria: `${tracks.length} unheard tracks from albums you started but never finished`,
    tracks,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "finish_album",
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
 * Explain why a filter-based genius type produced no tracks, referencing the
 * playback data available. ``top_artist``/``top_album``/``top_genre``/
 * ``deep_dive`` already return their own specific reasons and are left
 * untouched.
 *
 * Two different spans, because the constraint differs by type. Count- and
 * completion-based types care only about how many plays exist, so blaming the
 * device clock there would be nonsense; ``late_night`` is the one type whose
 * emptiness a bad clock genuinely explains. Neither is keyed off
 * ``dataMonths`` — a device with an unset clock has plenty of plays but zero
 * trustworthy months, and telling that user they have "almost no playback
 * history" is simply wrong.
 */
function emptyReasonFor(
  geniusType: string,
  ctx: PlaybackClockContext
): string | null {
  const volumeSpan =
    ctx.totalMatched === 0
      ? "There is no playback history yet."
      : `Only ${ctx.totalMatched} play${
          ctx.totalMatched === 1 ? " is" : "s are"
        } recorded so far.`;

  let clockSpan: string;
  if (ctx.totalMatched === 0) {
    clockSpan = "There is no playback history yet.";
  } else if (!ctx.clockValid) {
    clockSpan =
      `${ctx.totalMatched} plays are recorded, but the device clock is not ` +
      "set correctly, so their times of day cannot be used. Set it in Rockbox " +
      "under Settings → General Settings → System → Time & Date.";
  } else {
    clockSpan = `Playback logging currently covers ~${ctx.dataMonths} month${
      ctx.dataMonths === 1 ? "" : "s"
    }.`;
  }

  switch (geniusType) {
    case "most_played":
      return `No tracks met the minimum play count. ${volumeSpan}`;
    case "favorites":
      return `No tracks reached 85% average completion with enough plays. ${volumeSpan}`;
    case "skip_list":
      return `No tracks fell below 25% average completion — nothing looks skipped. ${volumeSpan}`;
    case "late_night":
      return `No tracks were played between 22:00 and 05:00 with high completion. ${clockSpan}`;
    case "recently_discovered":
      return `No single-play tracks were completed above 80%. ${volumeSpan}`;
    case "hidden_gems":
      return "Every track in your library has been played at least once.";
    case "finish_album":
      return (
        "No part-finished albums found — you have either completed every album " +
        "you started, or not played enough of one yet."
      );
    default:
      return null;
  }
}

/**
 * Generate a genius playlist from in-memory matched events.
 *
 * :param geniusType: One of the algorithm keys.
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
  // top_rated and hidden_gems are purely DB-driven — they read library
  // metadata and the absence of plays, so they must run before the
  // "no playback history" guard rather than being blocked by it.
  if (geniusType === "top_rated") {
    return generateTopRated(db, opts);
  }
  if (geniusType === "hidden_gems") {
    const gems = generateHiddenGems(db, opts);
    if (gems.tracks.length === 0) {
      const reason = emptyReasonFor(geniusType, getPlaybackDataContext(db));
      if (reason) gems.criteria = reason;
    }
    return gems;
  }

  if (!events.length) {
    return emptyResult(
      "No playback history in database. Connect a device and recheck for " +
        "playback.log data, or run a sync/device check.",
      geniusType
    );
  }

  const result = generateGeniusPlaylistByType(geniusType, events, db, opts);

  // If a filter-based type came back empty, replace the generic criteria with
  // a reason that names the data constraint responsible.
  if (result.tracks.length === 0) {
    const reason = emptyReasonFor(geniusType, getPlaybackDataContext(db));
    if (reason) result.criteria = reason;
  }

  return result;
}

function generateGeniusPlaylistByType(
  geniusType: string,
  events: MatchedPlayEvent[],
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
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
    case "top_genre":
      return generateTopGenre(opts, db);
    case "finish_album":
      return generateFinishAlbum(opts, db);
    default:
      throw new Error(`Unknown genius playlist type: ${geniusType}`);
  }
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
