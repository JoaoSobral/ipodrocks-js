/**
 * Assistant chat — context-aware bot with full library and playlist knowledge.
 * Used by the floating chat widget. Provides read-only access to the full DB.
 */

import Database from "better-sqlite3";
import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";
import { getAvailableGeniusTypes } from "../playlists/genius-engine";
import type {
  GeniusGenerateOptions,
  SmartPlaylistRule,
} from "../../shared/types";

const MAX_CONTEXT_TRACKS = 2500;
const MAX_PLAYLIST_TRACKS = 150;
const MAX_ASSISTANT_HISTORY = 100;
export const MAX_PINNED_MEMORIES = 40;

// ---------------------------------------------------------------------------
// F9: Library context cache — rebuilding on every message is expensive
// ---------------------------------------------------------------------------

const LIBRARY_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes

let libraryContextCache: { text: string; ts: number } | null = null;
let playlistInstructionsCache: { text: string; ts: number } | null = null;

/** Invalidate the assistant context caches (call after library/playlist changes). */
export function invalidateAssistantCache(): void {
  libraryContextCache = null;
  playlistInstructionsCache = null;
}

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

const ASSISTANT_SYSTEM_PROMPT = `You are the user's music buddy inside iPodRocks, a personal music library and iPod sync app.
You're warm, enthusiastic, and genuinely passionate about music. Talk like a close friend who shares their love of music — not a corporate assistant reading from a database.
You have full knowledge of their library: tracks, artists, albums, genres, playlists, listening history, and harmonic data. Use this to give personal, thoughtful responses.

Personality guidelines:
- Be warm, casual, and personal. Use their name naturally if you know it from pinned memories.
- Show genuine excitement about their music taste — react to what they listen to like a friend would.
- When referencing their library data, weave it into conversation naturally. Say things like "You've got so much great stuff from **Radiohead**!" instead of "My records show 42 Radiohead tracks."
- Use humor, enthusiasm, and personality. You're a music nerd who loves geeking out.
- Keep responses concise (1–4 sentences unless they ask for more) but make every word feel human.
- If asked about creating a Savant (AI) playlist, point them to the Playlists > Savant tab.

Format your replies with **Markdown** for readability:
- Use **bold** for artist names, album titles, or key terms.
- Use bullet lists when suggesting multiple tracks, albums, or playlists.
- Use numbered lists for step-by-step guidance.
- Use *italic* for emphasis or song titles.
- Use \`code\` for technical terms (e.g. genres, key/BPM).
- Add line breaks between logical sections.`;

// ---------------------------------------------------------------------------
// History persistence
// ---------------------------------------------------------------------------

export function loadAssistantHistory(
  db: Database.Database
): Array<{ role: "user" | "assistant"; content: string }> {
  const rows = db
    .prepare(
      "SELECT role, content FROM assistant_chat_history ORDER BY id ASC"
    )
    .all() as Array<{ role: string; content: string }>;
  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
  }));
}

export function loadNonPinnedHistory(
  db: Database.Database
): Array<{ role: "user" | "assistant"; content: string }> {
  const rows = db
    .prepare(
      "SELECT role, content FROM assistant_chat_history WHERE pinned = 0 ORDER BY id ASC"
    )
    .all() as Array<{ role: string; content: string }>;
  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
  }));
}

export function saveAssistantMessages(
  db: Database.Database,
  userContent: string,
  assistantContent: string
): { userMsgId: number; assistantMsgId: number } {
  const insert = db.prepare(
    "INSERT INTO assistant_chat_history (role, content) VALUES (?, ?)"
  );
  const trim = db.prepare(`
    DELETE FROM assistant_chat_history
    WHERE pinned = 0 AND id NOT IN (
      SELECT id FROM assistant_chat_history WHERE pinned = 0 ORDER BY id DESC LIMIT ?
    )
  `);
  let userMsgId = 0;
  let assistantMsgId = 0;
  db.transaction(() => {
    const ur = insert.run("user", userContent);
    userMsgId = Number(ur.lastInsertRowid);
    const ar = insert.run("assistant", assistantContent);
    assistantMsgId = Number(ar.lastInsertRowid);
    trim.run(MAX_ASSISTANT_HISTORY);
  })();
  return { userMsgId, assistantMsgId };
}

export function clearAssistantHistory(db: Database.Database): void {
  db.prepare("DELETE FROM assistant_chat_history").run();
}

// ---------------------------------------------------------------------------
// Pinned memories
// ---------------------------------------------------------------------------

export function pinMessages(
  db: Database.Database,
  userMsgId: number,
  assistantMsgId: number
): void {
  db.prepare(
    "UPDATE assistant_chat_history SET pinned = 1 WHERE id IN (?, ?)"
  ).run(userMsgId, assistantMsgId);
}

export function unpinMessages(
  db: Database.Database,
  userMsgId: number
): void {
  db.prepare(
    "UPDATE assistant_chat_history SET pinned = 0 WHERE id = ?"
  ).run(userMsgId);
  const next = db
    .prepare(
      "SELECT id FROM assistant_chat_history WHERE id > ? AND role = 'assistant' AND pinned = 1 ORDER BY id ASC LIMIT 1"
    )
    .get(userMsgId) as { id: number } | undefined;
  if (next) {
    db.prepare(
      "UPDATE assistant_chat_history SET pinned = 0 WHERE id = ?"
    ).run(next.id);
  }
}

export function getPinnedCount(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM assistant_chat_history WHERE pinned = 1 AND role = 'user'"
      )
      .get() as { c: number }
  ).c;
}

function buildPinnedMemoriesContext(
  db: Database.Database
): { text: string; count: number } {
  const rows = db
    .prepare(
      "SELECT id, role, content FROM assistant_chat_history WHERE pinned = 1 ORDER BY id ASC"
    )
    .all() as Array<{ id: number; role: string; content: string }>;
  if (rows.length === 0) return { text: "No pinned memories yet.", count: 0 };

  const pairs: string[] = [];
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === "user") {
      const userRow = rows[i];
      const assistantRow =
        i + 1 < rows.length && rows[i + 1].role === "assistant"
          ? rows[i + 1]
          : null;
      pairs.push(
        `Memory #${userRow.id}:\n  User: "${userRow.content}"\n  Assistant: "${assistantRow?.content ?? "(no response)"}"`
      );
      count++;
      if (assistantRow) i++;
    }
  }

  return { text: pairs.join("\n\n"), count };
}

// ---------------------------------------------------------------------------
// Action tag parsing — strips control tags from the LLM reply
// ---------------------------------------------------------------------------

export interface ParsedSmartPlaylist {
  name: string;
  rules: SmartPlaylistRule[];
  trackLimit?: number;
}

export interface ParsedGeniusPlaylist {
  name: string;
  geniusType: string;
  opts: GeniusGenerateOptions;
}

export function parseActionTags(reply: string): {
  cleanReply: string;
  pin: boolean;
  unpinIds: number[];
  replaceId: number | null;
  smartPlaylist: ParsedSmartPlaylist | null;
  geniusPlaylist: ParsedGeniusPlaylist | null;
} {
  let cleanReply = reply;
  let pin = false;
  const unpinIds: number[] = [];
  let replaceId: number | null = null;
  let smartPlaylist: ParsedSmartPlaylist | null = null;
  let geniusPlaylist: ParsedGeniusPlaylist | null = null;

  if (/<MEMORY_PIN\s*\/?>/.test(cleanReply)) {
    pin = true;
    cleanReply = cleanReply.replace(/<MEMORY_PIN\s*\/?>/g, "");
  }

  for (const m of cleanReply.matchAll(/<MEMORY_UNPIN>(\d+)<\/MEMORY_UNPIN>/g)) {
    unpinIds.push(parseInt(m[1], 10));
  }
  cleanReply = cleanReply.replace(/<MEMORY_UNPIN>\d+<\/MEMORY_UNPIN>/g, "");

  const replaceMatch = cleanReply.match(/<MEMORY_REPLACE>(\d+)<\/MEMORY_REPLACE>/);
  if (replaceMatch) {
    replaceId = parseInt(replaceMatch[1], 10);
    cleanReply = cleanReply.replace(/<MEMORY_REPLACE>\d+<\/MEMORY_REPLACE>/g, "");
  }

  const smartMatch = cleanReply.match(/<SMART_PLAYLIST>([\s\S]*?)<\/SMART_PLAYLIST>/);
  if (smartMatch) {
    try {
      const parsed = JSON.parse(smartMatch[1].trim()) as {
        name: string;
        rules: Array<{ ruleType: string; targetId: number | null; targetLabel: string }>;
        trackLimit?: number;
      };
      if (parsed.name && Array.isArray(parsed.rules) && parsed.rules.length > 0) {
        smartPlaylist = {
          name: parsed.name,
          rules: parsed.rules.map((r) => ({
            ruleType: r.ruleType,
            targetId: r.targetId ?? null,
            targetLabel: r.targetLabel ?? "",
          })),
          trackLimit: parsed.trackLimit,
        };
      }
    } catch {
      // ignore malformed JSON
    }
    cleanReply = cleanReply.replace(/<SMART_PLAYLIST>[\s\S]*?<\/SMART_PLAYLIST>/g, "");
  }

  const geniusMatch = cleanReply.match(/<GENIUS_PLAYLIST>([\s\S]*?)<\/GENIUS_PLAYLIST>/);
  if (geniusMatch) {
    try {
      const parsed = JSON.parse(geniusMatch[1].trim()) as {
        name: string;
        geniusType: string;
        maxTracks?: number;
        minPlays?: number;
        artist?: string;
        targetMonth?: number;
        targetYear?: number;
        rangeStartMonthsAgo?: number;
        rangeEndMonthsAgo?: number;
      };
      if (parsed.name && parsed.geniusType) {
        geniusPlaylist = {
          name: parsed.name,
          geniusType: parsed.geniusType,
          opts: {
            maxTracks: parsed.maxTracks,
            minPlays: parsed.minPlays,
            artist: parsed.artist,
            targetMonth: parsed.targetMonth,
            targetYear: parsed.targetYear,
            rangeStartMonthsAgo: parsed.rangeStartMonthsAgo,
            rangeEndMonthsAgo: parsed.rangeEndMonthsAgo,
          },
        };
      }
    } catch {
      // ignore malformed JSON
    }
    cleanReply = cleanReply.replace(/<GENIUS_PLAYLIST>[\s\S]*?<\/GENIUS_PLAYLIST>/g, "");
  }

  return {
    cleanReply: cleanReply.trim(),
    pin,
    unpinIds,
    replaceId,
    smartPlaylist,
    geniusPlaylist,
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

function buildMemoryInstructions(
  pinnedText: string,
  pinnedCount: number
): string {
  return `

## Persistent Memory
You have a persistent memory system with ${MAX_PINNED_MEMORIES} slots for important information the user wants you to always remember across sessions.

<pinned_memories>
${pinnedText}
</pinned_memories>
Memory slots used: ${pinnedCount}/${MAX_PINNED_MEMORIES}

### When to PIN a memory (save permanently):
When the user explicitly asks you to remember something using phrases like:
- "Always remember...", "Don't forget...", "Keep in mind...", "Remember that I...", "Make sure you never forget..."
- Or any clear intent to permanently store a preference, fact, or instruction about themselves or their listening habits

Include \`<MEMORY_PIN />\` at the very end of your response (after your natural reply).

### When to UNPIN a memory (forget / correct):
When the user asks to forget or correct something previously remembered:
- "Forget about...", "I changed my mind about...", "Actually my name is...", "Stop remembering...", "Delete that memory about..."
- Or any clear intent to correct or remove previously stored information

Include \`<MEMORY_UNPIN>MEMORY_NUMBER</MEMORY_UNPIN>\` at the end of your response, where MEMORY_NUMBER is the Memory # shown in <pinned_memories> above.
If correcting (e.g. "actually my name is X"), UNPIN the old memory AND PIN the new exchange by including both <MEMORY_UNPIN> and <MEMORY_PIN /> tags.

### When memory is FULL (${MAX_PINNED_MEMORIES}/${MAX_PINNED_MEMORIES} slots):
If all slots are used and the user asks to remember something new:
1. Evaluate whether the new information is truly important enough to replace an existing memory.
2. If yes, identify the least important existing memory and include \`<MEMORY_REPLACE>MEMORY_NUMBER</MEMORY_REPLACE>\` to replace it with the current exchange.
3. If the existing memories are all more important, politely explain that your memory is full and suggest they free up a slot first by asking you to forget something.

### Memory rules:
- ONLY use memory tags when the user EXPLICITLY asks to remember or forget something. Normal conversation must NEVER trigger memory tags.
- Keep your visible response natural and conversational — do NOT mention memory IDs, tags, slot counts, or the technical memory system to the user.
- Memory tags MUST appear at the very end of your response, after all visible content, on their own line.
- When the user asks to correct a memory, include BOTH <MEMORY_UNPIN> for the old memory AND <MEMORY_PIN /> for the new exchange.
`;
}

const PLAYLIST_REF_LIMIT = 80;

function buildPlaylistInstructions(db: Database.Database): string {
  const genres = db
    .prepare(
      `SELECT g.id, g.name FROM genres g
       JOIN tracks t ON t.genre_id = g.id AND t.content_type = 'music'
       GROUP BY g.id ORDER BY g.name LIMIT ?`
    )
    .all(PLAYLIST_REF_LIMIT) as Array<{ id: number; name: string }>;

  const artists = db
    .prepare(
      `SELECT a.id, a.name FROM artists a
       JOIN tracks t ON t.artist_id = a.id AND t.content_type = 'music'
       GROUP BY a.id ORDER BY a.name LIMIT ?`
    )
    .all(PLAYLIST_REF_LIMIT) as Array<{ id: number; name: string }>;

  const albums = db
    .prepare(
      `SELECT al.id, al.title, a.name as artist FROM albums al
       JOIN artists a ON al.artist_id = a.id
       JOIN tracks t ON t.album_id = al.id AND t.content_type = 'music'
       GROUP BY al.id ORDER BY a.name, al.title LIMIT ?`
    )
    .all(PLAYLIST_REF_LIMIT) as Array<{ id: number; title: string; artist: string | null }>;

  const geniusTypes = getAvailableGeniusTypes(db);

  const genreList = genres.map((g) => `  {"id":${g.id},"name":${JSON.stringify(g.name)}}`).join(",\n");
  const artistList = artists.map((a) => `  {"id":${a.id},"name":${JSON.stringify(a.name)}}`).join(",\n");
  const albumList = albums
    .map((a) => `  {"id":${a.id},"title":${JSON.stringify(a.title ?? "")},"artist":${JSON.stringify(a.artist ?? "")}}`)
    .join(",\n");

  const geniusList = geniusTypes
    .map(
      (t) =>
        `  - ${t.value}: ${t.label} — ${t.description}`
    )
    .join("\n");

  return `

## Playlist Creation
When the user explicitly asks you to create a Smart or Genius playlist, you can create it by including a tag at the very end of your response (after your natural reply).

### Smart Playlist (genre/artist/album-based)
Use when the user wants a playlist by genre, artist, or album. Rules use IDs from the reference lists below.
Format: \`<SMART_PLAYLIST>{"name":"Playlist Name","rules":[{"ruleType":"genre","targetId":5,"targetLabel":"Rock"}],"trackLimit":50}</SMART_PLAYLIST>\`
- ruleType: "genre" | "artist" | "album"
- targetId: must match an id from the reference list
- targetLabel: display name (genre name, artist name, or "Title — Artist" for album)
- trackLimit: optional, 10–300 (default 50)
- At least one rule required. Multiple rules of same type = OR; different types = AND.

Available genres (id, name):
[\n${genreList}\n]

Available artists (id, name):
[\n${artistList}\n]

Available albums (id, title, artist):
[\n${albumList}\n]

### Genius Playlist (playback-history-based)
Use when the user wants a playlist based on listening history (most played, favorites, late night, etc.).
Format: \`<GENIUS_PLAYLIST>{"name":"Playlist Name","geniusType":"late_night","maxTracks":30}</GENIUS_PLAYLIST>\`
- geniusType: one of the values below
- maxTracks: optional, default 25
- For deep_dive: add "artist":"Artist Name"
- For time_capsule: add "targetMonth":1–12, "targetYear":2020
- For golden_era: add "rangeStartMonthsAgo":48, "rangeEndMonthsAgo":24

Available genius types:
${geniusList}

### Rules
- ONLY emit playlist tags when the user EXPLICITLY asks to create a playlist. Normal conversation must NEVER trigger these tags.
- Confirm what you're creating in your natural reply before the tag.
- Tags MUST appear at the very end of your response, on their own line.
- Savant (AI mood-based) playlists are NOT supported here — direct the user to Playlists > Savant tab.
`;
}

export async function sendAssistantMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  db: Database.Database,
  config: OpenRouterConfig
): Promise<string> {
  // F9: Cache the expensive context queries with a 5-minute TTL
  const now = Date.now();
  if (!libraryContextCache || now - libraryContextCache.ts > LIBRARY_CONTEXT_TTL_MS) {
    libraryContextCache = { text: buildLibraryContext(db), ts: now };
  }
  if (!playlistInstructionsCache || now - playlistInstructionsCache.ts > LIBRARY_CONTEXT_TTL_MS) {
    playlistInstructionsCache = { text: buildPlaylistInstructions(db), ts: now };
  }
  const libraryContext = libraryContextCache.text;
  const playlistInstructions = playlistInstructionsCache.text;

  const { text: pinnedText, count: pinnedCount } =
    buildPinnedMemoriesContext(db);
  const memoryInstructions = buildMemoryInstructions(pinnedText, pinnedCount);

  const systemContent = `${ASSISTANT_SYSTEM_PROMPT}
${memoryInstructions}
${playlistInstructions}
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
