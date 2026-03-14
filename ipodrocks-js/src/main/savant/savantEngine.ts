/**
 * Savant playlist engine — AI-driven playlist generation via OpenRouter LLM.
 * Assembles context from library + playback stats, calls LLM, harmonic sequences, saves.
 */

import Database from "better-sqlite3";
import type { GenerateSavantResult, OpenRouterConfig, SavantIntent } from "../../shared/types";
import { callOpenRouter, OpenRouterMessage } from "../llm/openRouterClient";
import { getSavantPlaylistContext } from "./moodChat";
import { harmonicSequence, SequencerTrack } from "./harmonicSequencer";

export interface CandidateTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  genre: string | null;
  bpm: number | null;
  camelot: string | null;
  playCount: number;
  avgCompletion: number;
  lastPlayed: string | null;
}

export interface SavantContext {
  intent: SavantIntent;
  library: {
    totalTracks: number;
    artists: string[];
    genres: string[];
    hasKeyData: boolean;
    keyedTrackCount: number;
  };
  geniusSignals: {
    topArtists: Array<{ artist: string; playCount: number }>;
    topTracks: Array<{
      title: string;
      artist: string;
      completionRate: number;
    }>;
    skippedArtists: string[];
    timeOfDayPattern: "morning" | "afternoon" | "evening" | "latenight" | "mixed";
  } | null;
  candidateTracks: CandidateTrack[];
}

export interface SavantLLMResponse {
  selectedTrackIds: number[];
  playlistName: string;
  reasoning: string;
}

async function assembleSavantContext(
  intent: SavantIntent,
  db: Database.Database
): Promise<SavantContext> {
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

  const artists = (
    db.prepare(
      `SELECT DISTINCT a.name FROM artists a
       JOIN tracks t ON t.artist_id = a.id
       WHERE t.content_type = 'music' AND a.name IS NOT NULL AND a.name != ''
       ORDER BY a.name`
    ).all() as { name: string }[]
  ).map((r) => r.name);

  const genres = (
    db.prepare(
      `SELECT DISTINCT g.name FROM genres g
       JOIN tracks t ON t.genre_id = g.id
       WHERE t.content_type = 'music' AND g.name IS NOT NULL AND g.name != ''
       ORDER BY g.name`
    ).all() as { name: string }[]
  ).map((r) => r.name);

  let geniusSignals: SavantContext["geniusSignals"] = null;
  const statsRows = db
    .prepare(
      `SELECT t.id, a.name as artist, al.title as album, t.title as track_title,
              ps.total_plays, ps.avg_completion_rate, ps.last_played_at
       FROM playback_stats ps
       JOIN tracks t ON t.id = ps.track_id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.content_type = 'music'`
    )
    .all() as Array<{
    id: number;
    artist: string | null;
    album: string | null;
    track_title: string | null;
    total_plays: number;
    avg_completion_rate: number;
    last_played_at: string | null;
  }>;

  if (statsRows.length > 0) {
    const artistCounts = new Map<string, number>();
    const skippedArtists = new Set<string>();
    for (const r of statsRows) {
      const artist = r.artist ?? "Unknown";
      artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + r.total_plays);
      if (r.avg_completion_rate < 0.25 && r.total_plays > 1) {
        skippedArtists.add(artist);
      }
    }
    const topArtists = [...artistCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, playCount]) => ({ artist, playCount }));

    const topTracks = statsRows
      .filter((r) => r.total_plays > 0)
      .sort((a, b) => (b.avg_completion_rate ?? 0) - (a.avg_completion_rate ?? 0))
      .slice(0, 20)
      .map((r) => ({
        title: r.track_title ?? "Unknown",
        artist: r.artist ?? "Unknown",
        completionRate: r.avg_completion_rate ?? 0,
      }));

    geniusSignals = {
      topArtists,
      topTracks,
      skippedArtists: [...skippedArtists],
      timeOfDayPattern: "mixed",
    };
  }

  const baseQuery = `
    SELECT t.id, t.title, a.name as artist, al.title as album, g.name as genre,
           t.bpm, t.camelot,
           COALESCE(ps.total_plays, 0) as play_count,
           COALESCE(ps.avg_completion_rate, 0) as avg_completion,
           ps.last_played_at
    FROM tracks t
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN genres g ON t.genre_id = g.id
    LEFT JOIN playback_stats ps ON ps.track_id = t.id
    WHERE t.content_type = 'music'
  `;

  type RawRow = {
    id: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    genre: string | null;
    bpm: number | null;
    camelot: string | null;
    play_count: number;
    avg_completion: number;
    last_played_at: string | null;
  };

  const rawRows = db.prepare(baseQuery).all() as RawRow[];
  let allTracks: CandidateTrack[] = rawRows.map((r) => ({
    id: r.id,
    title: r.title ?? "Unknown",
    artist: r.artist ?? "Unknown",
    album: r.album ?? "Unknown",
    genre: r.genre ?? null,
    bpm: r.bpm,
    camelot: r.camelot,
    playCount: r.play_count,
    avgCompletion: r.avg_completion,
    lastPlayed: r.last_played_at,
  }));

  if (intent.adventureLevel === "conservative") {
    allTracks = allTracks.filter((t) => t.playCount > 0);
  } else if (intent.adventureLevel === "mixed") {
    const played = allTracks.filter((t) => t.playCount > 0);
    const unplayed = allTracks.filter((t) => t.playCount === 0);
    const unplayedSample = unplayed
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.ceil(unplayed.length * 0.3));
    allTracks = [...played, ...unplayedSample];
  }

  allTracks = allTracks.filter(
    (t) => !(t.avgCompletion < 0.25 && t.playCount > 1)
  );

  if (intent.seedArtist) {
    const seedTracks = allTracks.filter(
      (t) =>
        t.artist?.toLowerCase() === intent.seedArtist?.toLowerCase()
    );
    const otherTracks = allTracks.filter(
      (t) =>
        t.artist?.toLowerCase() !== intent.seedArtist?.toLowerCase()
    );
    const seedCount = Math.max(
      Math.ceil(allTracks.length * 0.2),
      Math.min(seedTracks.length, 50)
    );
    const seedSample = seedTracks.slice(0, seedCount);
    const otherSample = otherTracks
      .sort(() => Math.random() - 0.5)
      .slice(0, 250 - seedSample.length);
    allTracks = [...seedSample, ...otherSample];
  } else {
    allTracks = allTracks
      .sort(() => Math.random() - 0.5)
      .slice(0, 250);
  }

  return {
    intent,
    library: {
      totalTracks,
      artists,
      genres,
      hasKeyData: keyedCount > 0,
      keyedTrackCount: keyedCount,
    },
    geniusSignals,
    candidateTracks: allTracks,
  };
}

function buildSavantPrompt(
  ctx: SavantContext,
  db: Database.Database
): OpenRouterMessage[] {
  const system = `You are a music curator AI for a personal music player app (like Apple Genius).
You have access to the user's library and listening history.
Your job is to select tracks that match the user's stated mood and intent.
When tracks have Camelot key data, prefer selecting groups of tracks with
compatible keys (same number +/-1 or same number A/B) for smooth harmonic
transitions — similar to how a DJ mixes. This is secondary to mood fit.
You must respond ONLY with valid JSON — no prose, no markdown.`;

  const geniusBlock = ctx.geniusSignals
    ? `
- Top artists by play count: ${ctx.geniusSignals.topArtists
        .slice(0, 5)
        .map((a) => `${a.artist} (${a.playCount} plays)`)
        .join(", ")}
- Artists they tend to skip: ${ctx.geniusSignals.skippedArtists.join(", ") || "none identified"}
- Typical listening time: ${ctx.geniusSignals.timeOfDayPattern}
`
    : "- No listening history available";

  const chatHistory = ctx.intent.moodDiscoveryChat ?? [];
  const chatContext =
    chatHistory.length > 0
      ? `

The user went through a mood discovery conversation. Here is the full exchange:
${chatHistory
  .map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
  .join("\n")}

Mood summary derived from conversation: "${ctx.intent.mood}"
`
      : "";

  const playlistContext = getSavantPlaylistContext(db);

  const user = `
The user wants a playlist with this intent:
- Mood/vibe: "${ctx.intent.mood}"${chatContext}
- Seed artist preference: "${ctx.intent.seedArtist ?? "none"}"
- Adventure level: "${ctx.intent.adventureLevel}"
- Desired track count: ${ctx.intent.targetCount}

Their listening history signals:
${geniusBlock}
${playlistContext}

Here are ${ctx.candidateTracks.length} candidate tracks from their library to choose from:
${JSON.stringify(
  ctx.candidateTracks.map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    genre: t.genre,
    bpm: t.bpm,
    camelot: t.camelot,
    plays: t.playCount,
    completion: t.avgCompletion,
  })),
  null,
  2
)}

Select ${ctx.intent.targetCount} tracks that best fit the mood and intent.
Prioritize tracks with higher completion rates when mood is relaxed/focused.
For energetic moods, consider BPM if available.
When tracks have camelot key data, favor clusters of harmonically compatible
tracks (adjacent Camelot numbers or same number A/B swap) for smooth mixing.
Avoid tracks the user consistently skips.

Respond with this exact JSON structure:
{
  "selectedTrackIds": [<array of track ids in suggested order>],
  "playlistName": "<a creative, evocative name for this playlist>",
  "reasoning": "<1-2 sentences explaining the overall curation approach>"
}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function parseLLMResponse(raw: string): SavantLLMResponse {
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(cleaned) as {
    selectedTrackIds?: unknown;
    playlistName?: string;
    reasoning?: string;
  };

  if (!Array.isArray(parsed.selectedTrackIds)) {
    throw new Error("Invalid LLM response: missing selectedTrackIds array");
  }

  const selectedTrackIds = (parsed.selectedTrackIds as unknown[]).filter(
    (id): id is number => typeof id === "number"
  );

  return {
    selectedTrackIds,
    playlistName: parsed.playlistName ?? "Savant Mix",
    reasoning: parsed.reasoning ?? "",
  };
}

export async function generateSavantPlaylist(
  intent: SavantIntent,
  config: OpenRouterConfig,
  db: Database.Database,
  createSavantPlaylist: (
    name: string,
    trackIds: number[],
    savantConfig: string
  ) => number
): Promise<GenerateSavantResult> {
  const context = await assembleSavantContext(intent, db);

  if (context.candidateTracks.length === 0) {
    throw new Error("No candidate tracks in library");
  }

  const messages = buildSavantPrompt(context, db);
  const raw = await callOpenRouter(messages, config, true);
  const llmResult = parseLLMResponse(raw);

  const validIds = new Set(context.candidateTracks.map((t) => t.id));
  const selectedIds = llmResult.selectedTrackIds.filter((id) =>
    validIds.has(id)
  );

  if (selectedIds.length < 5) {
    throw new Error(
      `LLM returned too few valid tracks (${selectedIds.length}). Please try again.`
    );
  }

  const trackData = db
    .prepare(
      `SELECT id, camelot, bpm FROM tracks WHERE id IN (${selectedIds.map(() => "?").join(",")})`
    )
    .all(...selectedIds) as SequencerTrack[];

  const idToTrack = new Map(trackData.map((t) => [t.id, t]));
  const ordered = selectedIds
    .map((id) => idToTrack.get(id))
    .filter((t): t is SequencerTrack => t != null);

  const sequenced = harmonicSequence(ordered);

  const savantConfig = JSON.stringify({
    intent,
    model: config.model,
    reasoning: llmResult.reasoning,
    generatedAt: new Date().toISOString(),
  });

  const playlistId = createSavantPlaylist(
    llmResult.playlistName,
    sequenced.map((t) => t.id),
    savantConfig
  );

  return {
    playlistId,
    name: llmResult.playlistName,
    trackCount: sequenced.length,
    reasoning: llmResult.reasoning,
  };
}
