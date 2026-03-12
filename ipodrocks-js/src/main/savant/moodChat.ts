/**
 * Mood discovery chat — AI-guided conversation to build a rich mood profile
 * for Savant playlist generation. Max 6 exchanges, then summary + confirm.
 */

import Database from "better-sqlite3";
import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MoodChatState {
  messages: ChatMessage[];
  exchangeCount: number;
  isComplete: boolean;
  moodSummary: string | null;
  internalNotes: string;
}

export interface MoodChatTurn {
  aiMessage: string;
  isComplete: boolean;
  moodSummary: string | null;
}

const MOOD_CHAT_SYSTEM_PROMPT = `You are a perceptive music curator helping someone discover what they want to listen to.
Your job is to have a short, natural conversation to understand their mood and musical needs.

RULES:
- Ask ONE question per message. Never two.
- Keep responses to 1–3 sentences. Be concise and direct.
- Use casual, warm language. You're a music friend, not a therapist or assistant.
- You may reference artists, albums, or genres naturally when it helps (e.g. "that sounds like a late-night Radiohead kind of mood").
- After 3 exchanges OR when you have enough signal, issue a SUMMARY using this exact format:

SUMMARY: <a rich 2–4 sentence mood description that captures energy level, emotional tone,
texture preferences, and context — written as a music brief, not a sentence about the user>

After the SUMMARY, ask: "Does that capture it?"

If the user says yes or confirms, respond ONLY with: CONFIRMED

If the user says no or wants to adjust, ask one clarifying question and try again.

INTERNAL TRACKING (never reveal this to the user):
Track what you've learned so far:
- Context (where/what they're doing)
- Energy level (low/medium/high)
- Emotional tone (positive/negative/complex)
- Texture preference (vocal/instrumental, dense/spacious)
- Any artist/album anchors mentioned
- Contradictions detected

You have a max of 6 user messages total. At message 6, always issue a SUMMARY and close
regardless of whether confirmed, using: CONFIRMED (AUTO)`;

/**
 * Build context string with library, playlog, and harmonic data for mood chat.
 * Enables the AI to reference the user's collection and listening habits.
 */
export function buildSavantChatContext(db: Database.Database): string {
  const totalTracks = (
    db.prepare("SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'").get() as {
      c: number;
    }
  ).c;
  const keyedCount = (
    db.prepare(
      "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND camelot IS NOT NULL"
    ).get() as { c: number }
  ).c;
  const coveragePct =
    totalTracks > 0 ? Math.round((keyedCount / totalTracks) * 100) : 0;

  const artistCounts = db
    .prepare(
      `SELECT a.name, COUNT(t.id) as cnt
       FROM artists a
       JOIN tracks t ON t.artist_id = a.id AND t.content_type = 'music'
       GROUP BY a.id
       ORDER BY cnt DESC
       LIMIT 15`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const genreCounts = db
    .prepare(
      `SELECT g.name, COUNT(t.id) as cnt
       FROM genres g
       JOIN tracks t ON t.genre_id = g.id AND t.content_type = 'music'
       GROUP BY g.id
       ORDER BY cnt DESC
       LIMIT 12`
    )
    .all() as Array<{ name: string; cnt: number }>;

  const lines: string[] = [
    "## Library",
    `- Music: ${totalTracks} tracks`,
    `- Top artists: ${artistCounts.map((a) => a.name).join(", ") || "none"}`,
    `- Top genres: ${genreCounts.map((g) => g.name).join(", ") || "none"}`,
    "",
    "## Harmonic (key/BPM for mixing)",
    `- ${keyedCount}/${totalTracks} tracks have key data (${coveragePct}%)`,
  ];

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
      .slice(0, 8)
      .map(([artist, plays]) => `${artist} (${plays} plays)`);

    const topTracks = statsRows
      .filter((r) => r.total_plays > 0)
      .sort((a, b) => (b.avg_completion_rate ?? 0) - (a.avg_completion_rate ?? 0))
      .slice(0, 10)
      .map(
        (r) =>
          `${r.track_title ?? "?"} — ${r.artist ?? "?"} (${Math.round((r.avg_completion_rate ?? 0) * 100)}% completion)`
      );

    lines.push(
      "",
      "## Playlog (listening history)",
      `- Top artists by plays: ${topByPlays.join(", ") || "none"}`,
      `- Favorites (high completion): ${topTracks.join("; ") || "none"}`,
      `- Artists they tend to skip: ${[...skippedArtists].slice(0, 5).join(", ") || "none"}`
    );
  }

  lines.push(getSavantPlaylistContext(db));
  return lines.join("\n");
}

/**
 * Returns context string for playlists and recent Savant memory.
 * Used by Savant generation and chat.
 */
export function getSavantPlaylistContext(db: Database.Database): string {
  const playlists = db
    .prepare(
      `SELECT p.name, pt.name AS type_name,
              (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS track_count
       FROM playlists p
       JOIN playlist_types pt ON p.playlist_type_id = pt.id
       ORDER BY p.updated_at DESC
       LIMIT 50`
    )
    .all() as Array<{ name: string; type_name: string; track_count: number }>;
  const recentSavant = db
    .prepare(
      `SELECT p.name, p.savant_config,
              (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS track_count
       FROM playlists p
       JOIN playlist_types pt ON p.playlist_type_id = pt.id
       WHERE pt.name = 'savant' AND p.savant_config IS NOT NULL
       ORDER BY p.updated_at DESC
       LIMIT 10`
    )
    .all() as Array<{ name: string; savant_config: string | null; track_count: number }>;

  const lines: string[] = [
    "",
    "## Existing playlists (read-only)",
    playlists.length > 0
      ? playlists
          .map((p) => `- ${p.name} (${p.type_name}, ${p.track_count} tracks)`)
          .join("\n")
      : "- No playlists yet",
  ];
  if (recentSavant.length > 0) {
    const savantLines = recentSavant.map((p) => {
      let intent = "";
      try {
        const cfg = JSON.parse(p.savant_config ?? "{}") as {
          intent?: { mood?: string };
        };
        intent = cfg.intent?.mood
          ? ` — "${cfg.intent.mood.slice(0, 80)}${cfg.intent.mood.length > 80 ? "…" : ""}"`
          : "";
      } catch {
        /* ignore */
      }
      return `- ${p.name} (${p.track_count} tracks)${intent}`;
    });
    lines.push("", "## Recent Savant playlists (memory)", ...savantLines);
  }
  return lines.join("\n");
}

function extractSummaryFromMessage(content: string): string | null {
  const match = content.match(/SUMMARY:\s*([\s\S]+?)(?:\n\nDoes that|\n\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

function findLastSummaryInMessages(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const summary = extractSummaryFromMessage(messages[i].content);
      if (summary) return summary;
    }
  }
  return null;
}

function buildSystemContent(
  db: Database.Database | null,
  forceClose: boolean
): string {
  let content = MOOD_CHAT_SYSTEM_PROMPT;
  if (db) {
    const ctx = buildSavantChatContext(db);
    content += `\n\n<context>\n${ctx}\n</context>\n\nUse this context to tailor your questions. Reference their artists, genres, or listening habits when relevant.`;
  }
  if (forceClose) {
    content += "\n\nNOTE: This is message 6. You MUST issue a SUMMARY and close now.";
  }
  return content;
}

/**
 * Process one user message and return the AI response.
 */
export async function processMoodChatTurn(
  state: MoodChatState,
  userMessage: string,
  openRouterConfig: OpenRouterConfig,
  db: Database.Database | null = null
): Promise<MoodChatTurn> {
  state.messages.push({ role: "user", content: userMessage });
  state.exchangeCount++;

  const forceClose = state.exchangeCount >= 6;
  const systemContent = buildSystemContent(db, forceClose);

  const llmMessages: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    ...state.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const raw = await callOpenRouter(llmMessages, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  const isConfirmed =
    raw.trim() === "CONFIRMED" || raw.includes("CONFIRMED (AUTO)");
  const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]+?)(?:\n\nDoes that|$)/i);

  if (isConfirmed) {
    const extractedSummary =
      findLastSummaryInMessages(state.messages) ?? "Unresolved mood";
    state.isComplete = true;
    state.moodSummary = extractedSummary;

    return {
      aiMessage: raw,
      isComplete: true,
      moodSummary: extractedSummary,
    };
  }

  return {
    aiMessage: raw,
    isComplete: false,
    moodSummary: summaryMatch?.[1]?.trim() ?? null,
  };
}

/**
 * Start the mood discovery chat — AI asks the opening question.
 */
export async function startMoodChat(
  openRouterConfig: OpenRouterConfig,
  db: Database.Database | null = null
): Promise<{ state: MoodChatState; aiMessage: string }> {
  const state: MoodChatState = {
    messages: [],
    exchangeCount: 0,
    isComplete: false,
    moodSummary: null,
    internalNotes: "",
  };

  let systemContent =
    MOOD_CHAT_SYSTEM_PROMPT +
    "\n\nThe user just opened the mood discovery chat. Ask your opening anchor question now. Nothing else.";
  if (db) {
    const ctx = buildSavantChatContext(db);
    systemContent += `\n\n<context>\n${ctx}\n</context>\n\nUse this context to tailor your opening question.`;
  }

  const openingPrompt: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: "__START__" },
  ];

  const raw = await callOpenRouter(openingPrompt, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  return { state, aiMessage: raw };
}
