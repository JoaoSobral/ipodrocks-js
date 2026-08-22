import Database from "better-sqlite3";

import {
  AnalysisSummary,
  GeniusGenerateOptions,
  GeniusTypeOption,
  ListeningStats,
  ListeningStatsPeriod,
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
 * Build AnalysisSummary from the runtime counters imported off devices.
 *
 * ``dateRange`` spans the observations iPodRocks has made, not the plays
 * themselves: Rockbox records no dates, so the only honest range is the window
 * over which it has been watching the counters. Before a second import there is
 * nothing to span and it collapses to now.
 */
export function buildAnalysisSummaryFromDb(
  db: Database.Database
): AnalysisSummary {
  const totalRow = db
    .prepare(
      `SELECT COALESCE(SUM(total_plays), 0) as c,
              MIN(first_played_at) as first_ts,
              MAX(last_played_at) as last_ts
         FROM playback_stats`
    )
    .get() as { c: number; first_ts: string | null; last_ts: string | null };

  const totalPlays = totalRow.c ?? 0;
  const nowIso = new Date().toISOString();
  const first = totalRow.first_ts ?? nowIso;
  const last = totalRow.last_ts ?? nowIso;

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

/**
 * Build "Listening Stats" (top tracks/artists/genre, totals) for a given
 * period.
 *
 * ``all`` reads the library roll-up in ``playback_stats``, which holds every
 * play Rockbox has ever counted. ``year`` and ``month`` read
 * ``runtime_play_deltas`` instead, because Rockbox attaches no date to a play
 * and the only dated thing in the system is the moment an import saw a
 * counter rise. That makes the scoped periods honest but partial: they cover
 * the window since iPodRocks started watching, not the whole history, and a
 * fresh install has nothing dated to report until its second import.
 */
export function buildListeningStatsFromDb(
  db: Database.Database,
  period: ListeningStatsPeriod
): ListeningStats {
  const ctx = getPlaybackDataContext(db);

  if (period === "all") {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(ps.total_plays), 0) AS plays,
                COALESCE(SUM(ps.total_playtime_ms), 0) AS listeningMs,
                COUNT(*) AS uniqueTracks
           FROM playback_stats ps
           JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
          WHERE ps.total_plays > 0`
      )
      .get() as { plays: number; listeningMs: number; uniqueTracks: number };

    if ((totals.plays ?? 0) === 0) return emptyListeningStats(period, ctx);

    const topTracks = db
      .prepare(
        `SELECT t.id AS trackId, t.title AS title, a.name AS artist,
                ps.total_plays AS playCount
           FROM playback_stats ps
           JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
           LEFT JOIN artists a ON t.artist_id = a.id
          WHERE ps.total_plays > 0
          ORDER BY playCount DESC, title
          LIMIT 5`
      )
      .all() as TopTrackRow[];

    const topArtists = db
      .prepare(
        `SELECT a.name AS name, SUM(ps.total_plays) AS playCount
           FROM playback_stats ps
           JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
           LEFT JOIN artists a ON t.artist_id = a.id
          WHERE ps.total_plays > 0
          GROUP BY a.id
          ORDER BY playCount DESC, name
          LIMIT 5`
      )
      .all() as TopArtistRow[];

    const topGenre = db
      .prepare(
        `SELECT g.name AS name, SUM(ps.total_plays) AS playCount
           FROM playback_stats ps
           JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
           JOIN genres g ON g.id = t.genre_id
          WHERE ps.total_plays > 0
          GROUP BY t.genre_id
          ORDER BY playCount DESC, name
          LIMIT 1`
      )
      .get() as { name: string; playCount: number } | undefined;

    return buildStats(period, ctx, totals, topTracks, topArtists, topGenre);
  }

  // Calendar year or month, scoped over the dated observations.
  const now = new Date();
  const since = (
    period === "year"
      ? new Date(now.getFullYear(), 0, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1)
  ).toISOString();

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(d.plays_delta), 0) AS plays,
              COALESCE(SUM(d.playtime_delta_ms), 0) AS listeningMs,
              COUNT(DISTINCT d.track_id) AS uniqueTracks
         FROM runtime_play_deltas d
         JOIN tracks t ON t.id = d.track_id AND t.content_type = 'music'
        WHERE d.observed_at >= ?`
    )
    .get(since) as { plays: number; listeningMs: number; uniqueTracks: number };

  if ((totals.plays ?? 0) === 0) return emptyListeningStats(period, ctx);

  const topTracks = db
    .prepare(
      `SELECT t.id AS trackId, t.title AS title, a.name AS artist,
              SUM(d.plays_delta) AS playCount
         FROM runtime_play_deltas d
         JOIN tracks t ON t.id = d.track_id AND t.content_type = 'music'
         LEFT JOIN artists a ON t.artist_id = a.id
        WHERE d.observed_at >= ?
        GROUP BY t.id
        ORDER BY playCount DESC, title
        LIMIT 5`
    )
    .all(since) as TopTrackRow[];

  const topArtists = db
    .prepare(
      `SELECT a.name AS name, SUM(d.plays_delta) AS playCount
         FROM runtime_play_deltas d
         JOIN tracks t ON t.id = d.track_id AND t.content_type = 'music'
         LEFT JOIN artists a ON t.artist_id = a.id
        WHERE d.observed_at >= ?
        GROUP BY a.id
        ORDER BY playCount DESC, name
        LIMIT 5`
    )
    .all(since) as TopArtistRow[];

  const topGenre = db
    .prepare(
      `SELECT g.name AS name, SUM(d.plays_delta) AS playCount
         FROM runtime_play_deltas d
         JOIN tracks t ON t.id = d.track_id AND t.content_type = 'music'
         JOIN genres g ON g.id = t.genre_id
        WHERE d.observed_at >= ?
        GROUP BY t.genre_id
        ORDER BY playCount DESC, name
        LIMIT 1`
    )
    .get(since) as { name: string; playCount: number } | undefined;

  return buildStats(period, ctx, totals, topTracks, topArtists, topGenre);
}

interface TopTrackRow {
  trackId: number;
  title: string | null;
  artist: string | null;
  playCount: number;
}

interface TopArtistRow {
  name: string | null;
  playCount: number;
}

function emptyListeningStats(
  period: ListeningStatsPeriod,
  ctx: PlaybackDataContext
): ListeningStats {
  return {
    period,
    totalPlays: 0,
    totalListeningTimeMs: 0,
    uniqueTracksPlayed: 0,
    topTracks: [],
    topArtists: [],
    topGenre: null,
    // Lets the caller tell "nothing recorded" apart from "nothing in this
    // period yet" — the second only needs the user to wait for another sync.
    totalLibraryPlays: ctx.totalPlays,
  };
}

function buildStats(
  period: ListeningStatsPeriod,
  ctx: PlaybackDataContext,
  totals: { plays: number; listeningMs: number; uniqueTracks: number },
  topTracks: TopTrackRow[],
  topArtists: TopArtistRow[],
  topGenre: { name: string; playCount: number } | undefined
): ListeningStats {
  return {
    period,
    totalPlays: totals.plays ?? 0,
    totalListeningTimeMs: totals.listeningMs ?? 0,
    uniqueTracksPlayed: totals.uniqueTracks ?? 0,
    topTracks: topTracks.map((r) => ({
      trackId: r.trackId,
      title: r.title ?? "Unknown",
      artist: r.artist ?? "Unknown",
      playCount: r.playCount,
    })),
    topArtists: topArtists.map((r) => ({
      name: r.name ?? "Unknown",
      playCount: r.playCount,
    })),
    topGenre: topGenre
      ? { name: topGenre.name, playCount: topGenre.playCount }
      : null,
    totalLibraryPlays: ctx.totalPlays,
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
    requiresRuntimeData: true,
  },
  {
    value: "favorites",
    label: "Favorites",
    description:
      "Tracks you listen to right through \u2014 85%+ on average, played at least twice",
    icon: "\u2705",
    requiresRuntimeData: true,
  },
  {
    // Kept under its original value so existing saved playlists still resolve.
    // Rockbox does not record a skip, so this can no longer mean "songs you
    // always skip" -- see generateNeverFinished.
    value: "skip_list",
    label: "Never Finished",
    description:
      "Tracks you start but rarely finish \u2014 under 25% on average",
    icon: "\u23ED\uFE0F",
    requiresRuntimeData: true,
  },
  {
    value: "top_artist",
    label: "Top Artist",
    description: "All library tracks by your most-played artist",
    icon: "\uD83C\uDFA4",
    requiresRuntimeData: true,
  },
  {
    value: "top_album",
    label: "Top Album",
    description: "All library tracks from your most-played album",
    icon: "\uD83D\uDCBF",
    requiresRuntimeData: true,
  },
  {
    value: "forgotten_favorites",
    label: "Forgotten Favorites",
    description:
      "Well-rated or often-played tracks you haven't come back to",
    icon: "\uD83D\uDD70\uFE0F",
    requiresRuntimeData: true,
  },
  {
    value: "recently_discovered",
    label: "Recently Discovered",
    description:
      "Tracks played only once and heard right through \u2014 things you tried and liked",
    icon: "\uD83C\uDD95",
    requiresRuntimeData: true,
  },
  {
    value: "deep_dive",
    label: "Deep Dive (Artist)",
    description:
      "Pick an artist and get all their library tracks ordered by play count",
    icon: "\uD83D\uDD01",
    requiresRuntimeData: true,
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
    requiresRuntimeData: true,
  },
  {
    value: "finish_album",
    label: "Finish the Album",
    description:
      "Tracks you have not heard from albums you started but never finished",
    icon: "\uD83D\uDCC0",
    requiresRuntimeData: true,
  },
];

/**
 * Why a genius type has nothing to work with.
 *
 * Rockbox only records a play once it has run 15 seconds, so a library with no
 * counters at all almost always means the setting is off rather than that
 * nothing has been listened to.
 */
const RUNTIME_DATA_MISSING_REASON =
  "No play history yet. On the device, turn on Settings \u2192 Playback " +
  "Settings \u2192 Gather Runtime Data, listen to some music, then connect " +
  "the device and check it.";

/**
 * How much runtime data the library currently holds.
 *
 * There is deliberately nothing here about device clocks. The playback log
 * stamped every play with the device RTC, which is unset on most players and
 * reports the year 2000 — an entire layer of the app existed to detect and work
 * around that. Rockbox's runtime data carries no timestamps at all, so the
 * problem does not arise: what matters now is simply whether any counters have
 * been recorded.
 */
export interface PlaybackDataContext {
  /** Tracks with at least one recorded play. */
  tracksWithPlays: number;
  /** Total plays across the library. */
  totalPlays: number;
  /** Devices that have contributed runtime data. */
  deviceCount: number;
}

export function getPlaybackDataContext(
  db: Database.Database
): PlaybackDataContext {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS tracks,
              COALESCE(SUM(total_plays), 0) AS plays
         FROM playback_stats
        WHERE total_plays > 0`
    )
    .get() as { tracks: number; plays: number };

  const devices = db
    .prepare(
      "SELECT COUNT(DISTINCT device_id) AS n FROM device_runtime_stats"
    )
    .get() as { n: number };

  return {
    tracksWithPlays: row.tracks ?? 0,
    totalPlays: row.plays ?? 0,
    deviceCount: devices.n ?? 0,
  };
}

/**
 * Annotate every genius type with whether it can currently produce a
 * meaningful result, so the UI can disable it with a reason rather than let
 * the user generate an empty playlist.
 */
function annotateGeniusTypes(db: Database.Database): {
  types: GeniusTypeOption[];
} & PlaybackDataContext {
  const ctx = getPlaybackDataContext(db);
  const types = GENIUS_TYPES.map((t) => {
    const available = !t.requiresRuntimeData || ctx.tracksWithPlays > 0;
    return available
      ? { ...t, available: true }
      : {
          ...t,
          available: false,
          unavailableReason: RUNTIME_DATA_MISSING_REASON,
        };
  });
  return { types, ...ctx };
}

/**
 * Every genius type, including unavailable ones (the UI disables rather than
 * hides them), plus the context behind that decision.
 */
export function getGeniusTypesWithAvailability(db: Database.Database): {
  types: GeniusTypeOption[];
} & PlaybackDataContext {
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
 * Library tracks joined to the runtime counters Rockbox recorded.
 *
 * ``avg_completion`` is the playtime-weighted roll-up of Rockbox's own
 * autoscore (playtime / (length * playcount)), which is the direct equivalent
 * of the per-event completion ratio the playback log used to give.
 *
 * ``last_played_serial`` orders plays *within one device* and means nothing
 * across two, so it is only ever a tiebreak behind ``last_played_at`` -- the
 * real host-clock date recorded when an import saw the counter rise.
 */
const STAT_TRACK_SELECT = `
  SELECT t.id, t.path, t.filename, t.title, t.track_number, t.disc_number,
         a.name AS artist, al.title AS album, g.name AS genre,
         t.duration, t.rating,
         COALESCE(ps.total_plays, 0) AS play_count,
         COALESCE(ps.total_playtime_ms, 0) AS play_time_ms,
         COALESCE(ps.avg_completion_rate, 0) AS avg_completion,
         ps.last_played_at AS last_played_at,
         (SELECT MAX(r.last_played_serial) FROM device_runtime_stats r
           WHERE r.track_id = t.id) AS last_played_serial
  FROM tracks t
  LEFT JOIN artists a ON t.artist_id = a.id
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN genres g ON t.genre_id = g.id
  LEFT JOIN playback_stats ps ON ps.track_id = t.id
`;

interface StatTrackRow extends LibTrackRow {
  play_time_ms: number | null;
  avg_completion: number | null;
  last_played_at: string | null;
  last_played_serial: number | null;
}

/** A library track carrying its runtime counters. */
interface StatTrack extends PlaylistTrack {
  playCount: number;
  avgCompletionRate: number;
  playTimeMs: number;
  lastPlayedAt: string | null;
  lastPlayedSerial: number | null;
}

function statRowToTrack(r: StatTrackRow): StatTrack {
  return {
    ...rowToPlaylistTrack(r),
    playCount: r.play_count ?? 0,
    avgCompletionRate: r.avg_completion ?? 0,
    playTimeMs: r.play_time_ms ?? 0,
    lastPlayedAt: r.last_played_at,
    lastPlayedSerial: r.last_played_serial,
  };
}

/** Every music track with its runtime counters attached. */
function loadStatTracks(db: Database.Database): StatTrack[] {
  const rows = db
    .prepare(`${STAT_TRACK_SELECT} WHERE t.content_type = 'music'`)
    .all() as StatTrackRow[];
  return rows.map(statRowToTrack);
}

/**
 * Most recently played first.
 *
 * A real date wins over a play-order serial, and a track with neither sorts
 * last -- never in the middle, which is where a plain numeric compare on nulls
 * would put it.
 */
function byMostRecentlyPlayed(a: StatTrack, b: StatTrack): number {
  if (a.lastPlayedAt && b.lastPlayedAt) {
    const diff = b.lastPlayedAt.localeCompare(a.lastPlayedAt);
    if (diff !== 0) return diff;
  } else if (a.lastPlayedAt) return -1;
  else if (b.lastPlayedAt) return 1;
  return (b.lastPlayedSerial ?? -1) - (a.lastPlayedSerial ?? -1);
}

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
    albumArtist: r.artist ?? "Unknown",
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
      `${STAT_TRACK_SELECT}
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
      `${STAT_TRACK_SELECT}
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
      `${STAT_TRACK_SELECT}
       WHERE t.genre_id = ? AND t.content_type = 'music'
       ORDER BY play_count DESC, a.name, al.title,
                t.disc_number, t.track_number`
    )
    .all(genreId) as LibTrackRow[];
  return rows.map(rowToPlaylistTrack);
}

// -- the runtime-data algorithms ------------------------------------------
//
// Every one of these reads Rockbox's absolute counters rather than a stream of
// play events. Two consequences run through the lot of them:
//
//   * A play only registers once it has run 15 seconds, so a track skipped
//     straight away leaves no trace whatsoever. "Never played" and "always
//     skipped" are indistinguishable, and nothing here may pretend otherwise.
//   * There are no timestamps. Ordering by recency leans on the host-clock
//     date iPodRocks stamps when it sees a counter rise, falling back to
//     Rockbox's play-order serial.

function generateMostPlayed(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const minPlays = opts.minPlays ?? 1;

  const picked = tracks
    .filter((t) => t.playCount >= minPlays)
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, limit);

  return {
    playlistName: "Most Played",
    criteria: `Top ${picked.length} tracks by play count (min ${minPlays})`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "most_played",
  };
}

function generateFavorites(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const minPlays = opts.minPlays ?? 2;

  const picked = tracks
    .filter((t) => t.playCount >= minPlays && t.avgCompletionRate >= 0.85)
    .sort((a, b) => b.avgCompletionRate - a.avgCompletionRate)
    .slice(0, limit);

  return {
    playlistName: "Favorites",
    criteria:
      `${picked.length} tracks you listen to right through ` +
      `(85%+ on average, at least ${minPlays} plays)`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "favorites",
  };
}

/**
 * Tracks you start and abandon.
 *
 * This used to be a skip list, built from playback-log events that recorded
 * every play over half a second. Rockbox's runtime data only counts a play once
 * it has run 15 seconds, so the quick skip -- the thing a skip list is made of
 * -- is never recorded at all. What remains visible, and is genuinely useful,
 * is the track you keep starting and keep leaving before the end.
 */
function generateNeverFinished(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const picked = tracks
    .filter((t) => t.playCount > 0 && t.avgCompletionRate < 0.25)
    .sort((a, b) => a.avgCompletionRate - b.avgCompletionRate)
    .slice(0, limit);

  return {
    playlistName: "Never Finished",
    criteria: `${picked.length} tracks you start but rarely finish (under 25% on average)`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "skip_list",
  };
}

function generateTopArtist(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  // Weight by play count, not by how many of an artist's tracks happen to
  // carry a counter -- otherwise an artist with forty tracks played once each
  // outranks the one track played four hundred times.
  const artistPlays = new Map<string, number>();
  for (const t of tracks) {
    if (t.playCount <= 0) continue;
    artistPlays.set(t.artist, (artistPlays.get(t.artist) ?? 0) + t.playCount);
  }

  let topName = "";
  let topCount = 0;
  for (const [name, count] of artistPlays) {
    if (count > topCount) {
      topCount = count;
      topName = name;
    }
  }

  if (!topName) {
    return emptyResult("No play history yet", "top_artist");
  }

  const picked = getLibraryTracksByArtist(db, topName).slice(0, limit);

  return {
    playlistName: `Top Artist: ${topName}`,
    criteria: `All library tracks by ${topName} (${topCount} plays)`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_artist",
  };
}

function generateTopAlbum(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const albumPlays = new Map<
    string,
    { album: string; artist: string; count: number }
  >();
  for (const t of tracks) {
    if (t.playCount <= 0) continue;
    const key = `${t.artist}\0${t.album}`;
    const cur = albumPlays.get(key);
    if (cur) cur.count += t.playCount;
    else albumPlays.set(key, { album: t.album, artist: t.artist, count: t.playCount });
  }

  let topEntry: { album: string; artist: string; count: number } | null = null;
  for (const val of albumPlays.values()) {
    if (!topEntry || val.count > topEntry.count) topEntry = val;
  }

  if (!topEntry) {
    return emptyResult("No play history yet", "top_album");
  }

  const picked = getLibraryTracksByAlbum(
    db,
    topEntry.album,
    topEntry.artist
  ).slice(0, limit);

  return {
    playlistName: `Top Album: ${topEntry.album}`,
    criteria:
      `All library tracks from ${topEntry.album} ` +
      `by ${topEntry.artist} (${topEntry.count} plays)`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "top_album",
  };
}

/**
 * Well-liked tracks you have not come back to.
 *
 * Rockbox's play-order serial is per-device, so ranking "least recently played"
 * across two players would compare two unrelated counters. The list is scoped
 * to the single device holding the most runtime data, which is the one whose
 * ordering actually means something.
 */
function generateForgottenFavorites(
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const device = db
    .prepare(
      `SELECT device_id, COUNT(*) AS n
         FROM device_runtime_stats
        GROUP BY device_id
        ORDER BY n DESC
        LIMIT 1`
    )
    .get() as { device_id: number } | undefined;

  if (!device) {
    return emptyResult("No play history yet", "forgotten_favorites");
  }

  const rows = db
    .prepare(
      `${STAT_TRACK_SELECT}
       JOIN device_runtime_stats r ON r.track_id = t.id AND r.device_id = ?
       WHERE t.content_type = 'music'
         AND r.play_count > 0
         AND (t.rating >= 8 OR r.play_count >= 4)
       ORDER BY r.last_played_serial ASC, r.play_count DESC
       LIMIT ?`
    )
    .all(device.device_id, limit) as StatTrackRow[];

  return {
    playlistName: "Forgotten Favorites",
    criteria: `${rows.length} well-rated or often-played tracks you haven't returned to`,
    tracks: rows.map(statRowToTrack),
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "forgotten_favorites",
  };
}

function generateRecentlyDiscovered(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const picked = tracks
    .filter((t) => t.playCount === 1 && t.avgCompletionRate > 0.8)
    .sort(byMostRecentlyPlayed)
    .slice(0, limit);

  return {
    playlistName: "Recently Discovered",
    criteria: `${picked.length} tracks played once and heard right through`,
    tracks: picked,
    generatedAt: new Date().toISOString(),
    type: "genius",
    subtype: "recently_discovered",
  };
}

function generateDeepDive(
  tracks: StatTrack[],
  opts: GeniusGenerateOptions,
  db: Database.Database
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;
  const artistName = opts.artist;

  if (!artistName) {
    return emptyResult("No artist selected for Deep Dive", "deep_dive");
  }

  const playCountMap = new Map<number, number>();
  for (const t of tracks) {
    if (t.artist.toLowerCase() === artistName.toLowerCase()) {
      playCountMap.set(t.id, t.playCount);
    }
  }

  const allTracks = getLibraryTracksByArtist(db, artistName);
  allTracks.sort(
    (a, b) => (playCountMap.get(b.id) ?? 0) - (playCountMap.get(a.id) ?? 0)
  );

  const picked = allTracks.slice(0, limit).map((t) => ({
    ...t,
    playCount: playCountMap.get(t.id) ?? 0,
  }));

  return {
    playlistName: `Deep Dive: ${artistName}`,
    criteria: `All library tracks by ${artistName} ordered by play count`,
    tracks: picked,
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
      `${STAT_TRACK_SELECT}
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
 * "Never played" now means exactly what it says: Rockbox has no counter for
 * the track on any device. Rating-first ordering surfaces music the user
 * already liked enough to rate but never got round to, and the ``RANDOM()``
 * tiebreak stops the result being alphabetical by artist.
 *
 * One caveat worth remembering: Rockbox only counts a play once a track has
 * run 15 seconds, so a track started and immediately skipped, every time,
 * still lands here.
 */
function generateHiddenGems(
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  const limit = opts.maxTracks ?? 25;

  const rows = db
    .prepare(
      `${STAT_TRACK_SELECT}
       WHERE t.content_type = 'music'
         AND COALESCE(ps.total_plays, 0) = 0
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
      `SELECT t.genre_id AS gid, g.name AS name, SUM(ps.total_plays) AS plays
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id AND t.content_type = 'music'
       JOIN genres g ON g.id = t.genre_id
       WHERE ps.total_plays > 0
       GROUP BY t.genre_id
       ORDER BY plays DESC, g.name
       LIMIT 1`
    )
    .get() as { gid: number; name: string; plays: number } | undefined;

  if (!top) {
    return emptyResult("No play history yet", "top_genre");
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
                      SELECT 1 FROM playback_stats ps2
                      WHERE ps2.track_id = t.id AND ps2.total_plays > 0
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
         AND COALESCE(ps.total_plays, 0) = 0
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
 * Generate a genius playlist from the runtime counters in the database.
 * Used whether or not a device is connected — everything is already imported.
 */
export function generateGeniusPlaylistFromDb(
  geniusType: string,
  db: Database.Database,
  opts: GeniusGenerateOptions = {}
): PlaylistGenerationResult {
  return generateGeniusPlaylist(geniusType, db, opts);
}

/**
 * Explain why a filter-based genius type produced no tracks, naming the
 * constraint responsible. ``top_artist``/``top_album``/``top_genre``/
 * ``deep_dive`` already return their own specific reasons and are left alone.
 *
 * Everything is keyed off how many plays exist. There is no device-clock
 * branch any more: Rockbox's runtime data carries no timestamps, so an unset
 * clock on the player no longer affects anything here.
 */
function emptyReasonFor(
  geniusType: string,
  ctx: PlaybackDataContext
): string | null {
  const volumeSpan =
    ctx.totalPlays === 0
      ? "No plays have been recorded yet."
      : `Only ${ctx.totalPlays} play${
          ctx.totalPlays === 1 ? " is" : "s are"
        } recorded so far.`;

  switch (geniusType) {
    case "most_played":
      return `No tracks met the minimum play count. ${volumeSpan}`;
    case "favorites":
      return `No tracks reached 85% average completion with enough plays. ${volumeSpan}`;
    case "skip_list":
      return (
        "No tracks fall below 25% average completion. " +
        "Note that Rockbox only counts a play once a track has run 15 seconds, " +
        `so tracks you skip immediately are never recorded. ${volumeSpan}`
      );
    case "forgotten_favorites":
      return `No well-rated or often-played tracks are waiting to be revisited. ${volumeSpan}`;
    case "recently_discovered":
      return `No single-play tracks were heard through to the end. ${volumeSpan}`;
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
 * Generate a genius playlist from the runtime counters in the database.
 *
 * :param geniusType: One of the algorithm keys.
 * :param db: Open SQLite connection.
 * :param opts: User-configurable generation options.
 * :returns: A PlaylistGenerationResult with the track preview.
 */
export function generateGeniusPlaylist(
  geniusType: string,
  db: Database.Database,
  opts: GeniusGenerateOptions = {}
): PlaylistGenerationResult {
  // top_rated and hidden_gems read library metadata and the *absence* of
  // plays, so they work on a library that has never been near a device and
  // must run before the "no play history" guard rather than be blocked by it.
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

  const ctx = getPlaybackDataContext(db);
  if (ctx.tracksWithPlays === 0) {
    return emptyResult(RUNTIME_DATA_MISSING_REASON, geniusType);
  }

  const result = generateGeniusPlaylistByType(geniusType, db, opts);

  // If a filter-based type came back empty, replace the generic criteria with
  // a reason that names the data constraint responsible.
  if (result.tracks.length === 0) {
    const reason = emptyReasonFor(geniusType, ctx);
    if (reason) result.criteria = reason;
  }

  return result;
}

function generateGeniusPlaylistByType(
  geniusType: string,
  db: Database.Database,
  opts: GeniusGenerateOptions
): PlaylistGenerationResult {
  // Loaded once per generation: the counter-based types all walk the same set
  // of library tracks, and each of them re-querying would be one full library
  // scan per playlist.
  const tracks = (): StatTrack[] => loadStatTracks(db);

  switch (geniusType) {
    case "most_played":
      return generateMostPlayed(tracks(), opts);
    case "favorites":
      return generateFavorites(tracks(), opts);
    case "skip_list":
      return generateNeverFinished(tracks(), opts);
    case "top_artist":
      return generateTopArtist(tracks(), opts, db);
    case "top_album":
      return generateTopAlbum(tracks(), opts, db);
    case "forgotten_favorites":
      return generateForgottenFavorites(db, opts);
    case "recently_discovered":
      return generateRecentlyDiscovered(tracks(), opts);
    case "deep_dive":
      return generateDeepDive(tracks(), opts, db);
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
