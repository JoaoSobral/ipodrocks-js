/**
 * Assistant chat — context-aware bot with library and playlist knowledge.
 * Used by the floating chat widget.
 */

import Database from "better-sqlite3";
import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";

const MAX_CONTEXT_TRACKS = 200;
const MAX_CONTEXT_PLAYLISTS = 50;

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

  const playlists = db
    .prepare(
      `SELECT p.id, p.name, pt.name as type_name,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) as track_count
       FROM playlists p
       JOIN playlist_types pt ON p.playlist_type_id = pt.id
       ORDER BY p.name
       LIMIT ?`
    )
    .all(MAX_CONTEXT_PLAYLISTS) as Array<{
    id: number;
    name: string;
    type_name: string;
    track_count: number;
  }>;

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

  const artistCounts = db
    .prepare(
      `SELECT a.name, COUNT(t.id) as cnt
       FROM artists a
       JOIN tracks t ON t.artist_id = a.id AND t.content_type = 'music'
       GROUP BY a.id
       ORDER BY cnt DESC
       LIMIT 30`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const genreCounts = db
    .prepare(
      `SELECT g.name, COUNT(t.id) as cnt
       FROM genres g
       JOIN tracks t ON t.genre_id = g.id AND t.content_type = 'music'
       GROUP BY g.id
       ORDER BY cnt DESC
       LIMIT 20`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const lines: string[] = [
    "## Library summary",
    `- Music: ${stats.music} tracks, ${stats.artists} artists, ${stats.albums} albums, ${stats.genres} genres`,
    `- Podcasts: ${stats.podcast} tracks`,
    `- Audiobooks: ${stats.audiobook} tracks`,
    "",
    "## Top artists (by track count)",
    artistCounts.map((a) => `- ${a.name}: ${a.cnt} tracks`).join("\n"),
    "",
    "## Top genres",
    genreCounts.map((g) => `- ${g.name}: ${g.cnt} tracks`).join("\n"),
    "",
    "## Playlists",
    playlists
      .map((p) => `- "${p.name}" (${p.type_name}): ${p.track_count} tracks`)
      .join("\n"),
    "",
    "## Sample tracks (title, artist, album, genre)",
    tracks
      .map(
        (t) =>
          `- ${t.title ?? "?"} | ${t.artist ?? "?"} | ${t.album ?? "?"} | ${t.genre ?? "?"}`
      )
      .join("\n"),
  ];

  return lines.join("\n");
}

const ASSISTANT_SYSTEM_PROMPT = `You are a helpful music assistant for iPodRocks, a personal music library and iPod sync app.
You have access to the user's library (tracks, artists, albums, genres) and playlists.
Answer questions about their music, suggest playlists, help find tracks, or assist with mood-based recommendations.
Keep responses concise (1–4 sentences unless the user asks for more).
If asked about creating a Savant (AI) playlist, direct them to the Playlists > Savant tab.`;

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
