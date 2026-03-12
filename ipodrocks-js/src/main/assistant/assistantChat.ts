/**
 * Assistant chat — context-aware bot with full library and playlist knowledge.
 * Used by the floating chat widget. Provides read-only access to the full DB.
 */

import Database from "better-sqlite3";
import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";

const MAX_CONTEXT_TRACKS = 2500;
const MAX_PLAYLIST_TRACKS = 150;

function buildLibraryContext(db: Database.Database): string {
  const stats = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM tracks WHERE content_type = 'music') as music,
        (SELECT COUNT(*) FROM tracks WHERE content_type = 'podcast') as podcast,
        (SELECT COUNT(*) FROM tracks WHERE content_type = 'audiobook') as audiobook,
        (SELECT COUNT(DISTINCT artist_id) FROM tracks WHERE content_type = 'music') as artists,
        (SELECT COUNT(DISTINCT album_id) FROM tracks WHERE content_type = 'music') as albums,
        (SELECT COUNT(DISTINCT genre_id) FROM tracks WHERE content_type = 'music') as genres`
    )
    .get() as {
    music: number;
    podcast: number;
    audiobook: number;
    artists: number;
    albums: number;
    genres: number;
  };

  const keyedCount = (
    db.prepare(
      "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND camelot IS NOT NULL"
    ).get() as { c: number }
  ).c;
  const harmonicPct =
    stats.music > 0 ? Math.round((keyedCount / stats.music) * 100) : 0;

  const artistCounts = db
    .prepare(
      `SELECT a.name, COUNT(t.id) as cnt
       FROM artists a
       JOIN tracks t ON t.artist_id = a.id AND t.content_type = 'music'
       GROUP BY a.id
       ORDER BY cnt DESC`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const genreCounts = db
    .prepare(
      `SELECT g.name, COUNT(t.id) as cnt
       FROM genres g
       JOIN tracks t ON t.genre_id = g.id AND t.content_type = 'music'
       GROUP BY g.id
       ORDER BY cnt DESC`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const playlists = db
    .prepare(
      `SELECT p.id, p.name, pt.name as type_name,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) as track_count
       FROM playlists p
       JOIN playlist_types pt ON p.playlist_type_id = pt.id
       ORDER BY p.name`
    )
    .all() as Array<{
    id: number;
    name: string;
    type_name: string;
    track_count: number;
  }>;

  const getPlaylistTracks = db.prepare(
    `SELECT t.title, a.name as artist
       FROM playlist_items pi
       JOIN tracks t ON t.id = pi.track_id AND t.content_type = 'music'
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE pi.playlist_id = ?
       ORDER BY pi.position
       LIMIT ?`
  );

  const tracks = db
    .prepare(
      `SELECT t.id, t.title, a.name as artist, al.title as album, g.name as genre
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN genres g ON t.genre_id = g.id
       WHERE t.content_type = 'music'
       ORDER BY a.name, al.title, t.track_number
       LIMIT ?`
    )
    .all(MAX_CONTEXT_TRACKS) as Array<{
    id: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
  }>;

  const statsRows = db
    .prepare(
      `SELECT t.id, a.name as artist, t.title as track_title,
              ps.total_plays, ps.avg_completion_rate
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE t.content_type = 'music'`
    )
    .all() as Array<{
    artist: string | null;
    track_title: string | null;
    total_plays: number;
    avg_completion_rate: number;
  }>;

  const lines: string[] = [
    "## Library summary",
    `- Music: ${stats.music} tracks, ${stats.artists} artists, ${stats.albums} albums, ${stats.genres} genres`,
    `- Podcasts: ${stats.podcast} tracks`,
    `- Audiobooks: ${stats.audiobook} tracks`,
    `- Harmonic data (key/BPM): ${keyedCount}/${stats.music} tracks (${harmonicPct}%)`,
    "",
    "## All artists (by track count)",
    artistCounts.map((a) => `- ${a.name}: ${a.cnt} tracks`).join("\n"),
    "",
    "## All genres",
    genreCounts.map((g) => `- ${g.name}: ${g.cnt} tracks`).join("\n"),
    "",
    "## All playlists (with track lists)",
  ];

  for (const p of playlists) {
    const items = getPlaylistTracks.all(
      p.id,
      MAX_PLAYLIST_TRACKS
    ) as Array<{ title: string | null; artist: string | null }>;
    const trackList = items
      .map((i) => `${i.title ?? "?"} — ${i.artist ?? "?"}`)
      .join("; ");
    const suffix =
      p.track_count > MAX_PLAYLIST_TRACKS
        ? ` (showing first ${MAX_PLAYLIST_TRACKS} of ${p.track_count})`
        : "";
    lines.push(`- "${p.name}" (${p.type_name}): ${p.track_count} tracks${suffix}`);
    if (trackList) lines.push(`  Tracks: ${trackList}`);
  }

  if (statsRows.length > 0) {
    const artistPlays = new Map<string, number>();
    const skippedArtists = new Set<string>();
    for (const r of statsRows) {
      const artist = r.artist ?? "Unknown";
      artistPlays.set(artist, (artistPlays.get(artist) ?? 0) + r.total_plays);
      if (r.avg_completion_rate < 0.25 && r.total_plays > 1) {
        skippedArtists.add(artist);
      }
    }
    const topByPlays = [...artistPlays.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([artist, plays]) => `${artist} (${plays} plays)`);
    const topTracks = statsRows
      .filter((r) => r.total_plays > 0)
      .sort((a, b) => (b.avg_completion_rate ?? 0) - (a.avg_completion_rate ?? 0))
      .slice(0, 20)
      .map(
        (r) =>
          `${r.track_title ?? "?"} — ${r.artist ?? "?"} (${Math.round((r.avg_completion_rate ?? 0) * 100)}% completion)`
      );
    lines.push(
      "",
      "## Playlog (listening history)",
      `- Top artists by plays: ${topByPlays.join(", ") || "none"}`,
      `- Favorites (high completion): ${topTracks.join("; ") || "none"}`,
      `- Artists they tend to skip: ${[...skippedArtists].slice(0, 8).join(", ") || "none"}`
    );
  }

  const trackSuffix =
    stats.music > MAX_CONTEXT_TRACKS
      ? ` (showing first ${MAX_CONTEXT_TRACKS} of ${stats.music})`
      : "";
  lines.push(
    "",
    `## All tracks (title | artist | album | genre)${trackSuffix}`,
    tracks
      .map(
        (t) =>
          `- ${t.title ?? "?"} | ${t.artist ?? "?"} | ${t.album ?? "?"} | ${t.genre ?? "?"}`
      )
      .join("\n")
  );

  return lines.join("\n");
}

const ASSISTANT_SYSTEM_PROMPT = `You are a helpful music assistant for iPodRocks, a personal music library and iPod sync app.
You have read-only access to the user's full database: all tracks, artists, albums, genres, playlists (with track lists), playlog (listening history), and harmonic data.
Use this context to answer questions about their music, suggest playlists, help find tracks, recommend based on mood or listening habits, or discuss any aspect of their library.
Keep responses concise (1–4 sentences unless the user asks for more).
If asked about creating a Savant (AI) playlist, direct them to the Playlists > Savant tab.

Format your replies with **Markdown** for readability:
- Use **bold** for artist names, album titles, or key terms.
- Use bullet lists when suggesting multiple tracks, albums, or playlists.
- Use numbered lists for step-by-step guidance.
- Use *italic* for emphasis or song titles.
- Use \`code\` for technical terms (e.g. genres, key/BPM).
- Add line breaks between logical sections.`;

export async function sendAssistantMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  db: Database.Database,
  config: OpenRouterConfig
): Promise<string> {
  const libraryContext = buildLibraryContext(db);

  const systemContent = `${ASSISTANT_SYSTEM_PROMPT}

<library_context>
${libraryContext}
</library_context>

Use the library context above to answer the user's questions. If they ask about something not in the context, say you don't have that information.`;

  const llmMessages: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  return callOpenRouter(llmMessages, config, false);
}
