/**
 * Assistant chat — context-aware bot with full library and playlist knowledge.
 * Used by the floating chat widget. Provides read-only access to the full DB.
 */

import Database from "better-sqlite3";
import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";
import { APP_DOCS } from "./appDocs";
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
let appDataContextCache: { text: string; ts: number } | null = null;

/** Invalidate the assistant context caches (call after library/playlist/device/podcast changes). */
export function invalidateAssistantCache(): void {
  libraryContextCache = null;
  playlistInstructionsCache = null;
  appDataContextCache = null;
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

function buildDevicesContext(db: Database.Database): string {
  const devices = db
    .prepare(
      `SELECT d.id, d.name, d.mount_path, d.music_folder, d.podcast_folder,
              d.audiobook_folder, d.playlist_folder, d.description,
              d.last_sync_date, d.total_synced_items, d.last_sync_count,
              d.source_library_type, d.shadow_library_id,
              d.partial_sync_enabled, d.skip_playback_log, d.rockbox_smart_playlists,
              d.dev_mode, d.auto_podcasts_enabled,
              dm.name as model_name,
              cc.name as codec_config_name, co.name as codec_name,
              cc.bitrate_value, cc.quality_value, cc.bits_per_sample,
              dtm.name as transfer_mode,
              sl.name as shadow_library_name
       FROM devices d
       LEFT JOIN device_models dm ON d.model_id = dm.id
       LEFT JOIN codec_configurations cc ON d.default_codec_config_id = cc.id
       LEFT JOIN codecs co ON cc.codec_id = co.id
       LEFT JOIN device_transfer_modes dtm ON d.default_transfer_mode_id = dtm.id
       LEFT JOIN shadow_libraries sl ON d.shadow_library_id = sl.id
       ORDER BY d.id`
    )
    .all() as Array<{
    id: number;
    name: string;
    mount_path: string;
    music_folder: string;
    podcast_folder: string;
    audiobook_folder: string;
    playlist_folder: string;
    description: string | null;
    last_sync_date: string | null;
    total_synced_items: number;
    last_sync_count: number;
    source_library_type: string;
    shadow_library_id: number | null;
    partial_sync_enabled: number;
    skip_playback_log: number;
    rockbox_smart_playlists: number;
    dev_mode: number;
    auto_podcasts_enabled: number;
    model_name: string | null;
    codec_config_name: string | null;
    codec_name: string | null;
    bitrate_value: number | null;
    quality_value: number | null;
    bits_per_sample: number | null;
    transfer_mode: string | null;
    shadow_library_name: string | null;
  }>;

  const getSyncPrefs = db.prepare(
    `SELECT sync_type, extra_track_policy, include_music, include_podcasts,
            include_audiobooks, include_playlists, skip_album_artwork
     FROM device_sync_preferences WHERE device_id = ?`
  );

  if (devices.length === 0) return "## Devices\nNo devices configured.";

  const lines = ["## Devices", `Total: ${devices.length}`];
  for (const d of devices) {
    lines.push("", `### Device: ${d.name}`);
    lines.push(`- Model: ${d.model_name ?? "Unknown"}`);
    lines.push(`- Mount path: ${d.mount_path}`);
    lines.push(
      `- Folders: Music: ${d.music_folder}, Podcasts: ${d.podcast_folder}, Audiobooks: ${d.audiobook_folder}, Playlists: ${d.playlist_folder}`
    );
    if (d.codec_config_name) {
      const bitrateLabel = d.bitrate_value
        ? `${d.bitrate_value}kbps`
        : d.quality_value
          ? `Q${d.quality_value}`
          : d.bits_per_sample
            ? `${d.bits_per_sample}bit`
            : "";
      lines.push(
        `- Codec: ${d.codec_name ?? "?"} / ${d.codec_config_name}${bitrateLabel ? ` (${bitrateLabel})` : ""}`
      );
    }
    const shadowSuffix =
      d.source_library_type === "shadow" && d.shadow_library_name
        ? ` → ${d.shadow_library_name}`
        : "";
    lines.push(`- Source library: ${d.source_library_type}${shadowSuffix}`);
    lines.push(
      `- Last sync: ${d.last_sync_date ?? "Never"} (total synced: ${d.total_synced_items}, last run: ${d.last_sync_count})`
    );
    const flags: string[] = [];
    if (d.auto_podcasts_enabled) flags.push("AutoPodcasts");
    if (d.skip_playback_log) flags.push("SkipPlaybackLog");
    if (d.dev_mode) flags.push("DevMode");
    if (d.rockbox_smart_playlists) flags.push("RockboxSmartPlaylists");
    if (d.partial_sync_enabled) flags.push("PartialSync");
    if (flags.length > 0) lines.push(`- Features: ${flags.join(", ")}`);
    if (d.description) lines.push(`- Notes: ${d.description}`);
    const prefs = getSyncPrefs.get(d.id) as {
      sync_type: string;
      extra_track_policy: string;
      include_music: number;
      include_podcasts: number;
      include_audiobooks: number;
      include_playlists: number;
      skip_album_artwork: number;
    } | undefined;
    if (prefs) {
      const content: string[] = [];
      if (prefs.include_music) content.push("music");
      if (prefs.include_podcasts) content.push("podcasts");
      if (prefs.include_audiobooks) content.push("audiobooks");
      if (prefs.include_playlists) content.push("playlists");
      lines.push(
        `- Sync config: ${prefs.sync_type}${content.length ? ` (${content.join(", ")})` : ""}, extra tracks: ${prefs.extra_track_policy}${prefs.skip_album_artwork ? ", no artwork" : ""}`
      );
    }
  }

  return lines.join("\n");
}

function buildShadowLibrariesContext(db: Database.Database): string {
  const libs = db
    .prepare(
      `SELECT sl.id, sl.name, sl.path, sl.status, sl.created_at,
              cc.name as codec_config_name, co.name as codec_name,
              cc.bitrate_value, cc.quality_value, cc.bits_per_sample,
              (SELECT COUNT(*) FROM shadow_tracks st
               WHERE st.shadow_library_id = sl.id AND st.status = 'synced') as synced_tracks,
              (SELECT COUNT(*) FROM shadow_tracks st
               WHERE st.shadow_library_id = sl.id) as total_tracks
       FROM shadow_libraries sl
       JOIN codec_configurations cc ON sl.codec_config_id = cc.id
       JOIN codecs co ON cc.codec_id = co.id
       ORDER BY sl.id`
    )
    .all() as Array<{
    id: number;
    name: string;
    path: string;
    status: string;
    created_at: string;
    codec_config_name: string;
    codec_name: string;
    bitrate_value: number | null;
    quality_value: number | null;
    bits_per_sample: number | null;
    synced_tracks: number;
    total_tracks: number;
  }>;

  const getDevicesUsing = db.prepare(
    "SELECT name FROM devices WHERE shadow_library_id = ?"
  );

  if (libs.length === 0) return "## Shadow Libraries\nNo shadow libraries configured.";

  const lines = ["## Shadow Libraries", `Total: ${libs.length}`];
  for (const sl of libs) {
    const bitrateLabel = sl.bitrate_value
      ? `${sl.bitrate_value}kbps`
      : sl.quality_value
        ? `Q${sl.quality_value}`
        : sl.bits_per_sample
          ? `${sl.bits_per_sample}bit`
          : "";
    const usingDevices = (
      getDevicesUsing.all(sl.id) as Array<{ name: string }>
    ).map((d) => d.name);
    lines.push("", `### Shadow Library: ${sl.name}`);
    lines.push(
      `- Codec: ${sl.codec_name} / ${sl.codec_config_name}${bitrateLabel ? ` (${bitrateLabel})` : ""}`
    );
    lines.push(`- Path: ${sl.path}`);
    lines.push(
      `- Status: ${sl.status} (${sl.synced_tracks}/${sl.total_tracks} tracks synced)`
    );
    lines.push(
      `- Used by devices: ${usingDevices.length > 0 ? usingDevices.join(", ") : "none"}`
    );
  }

  return lines.join("\n");
}

function buildAutoPodcastsContext(
  db: Database.Database,
  autoPodcastEnabled: boolean,
  autoPodcastIntervalMin: number
): string {
  const subs = db
    .prepare(
      `SELECT ps.id, ps.title, ps.author, ps.auto_count, ps.last_refreshed_at,
              (SELECT COUNT(*) FROM podcast_episodes pe WHERE pe.subscription_id = ps.id) as total_eps,
              (SELECT COUNT(*) FROM podcast_episodes pe
               WHERE pe.subscription_id = ps.id AND pe.download_state = 'ready') as ready_eps,
              (SELECT COUNT(*) FROM podcast_episodes pe
               WHERE pe.subscription_id = ps.id AND pe.download_state = 'pending') as pending_eps,
              (SELECT COUNT(*) FROM podcast_episodes pe
               WHERE pe.subscription_id = ps.id AND pe.download_state = 'failed') as failed_eps
       FROM podcast_subscriptions ps
       ORDER BY ps.title`
    )
    .all() as Array<{
    id: number;
    title: string;
    author: string | null;
    auto_count: number;
    last_refreshed_at: string | null;
    total_eps: number;
    ready_eps: number;
    pending_eps: number;
    failed_eps: number;
  }>;

  const devicesWithPodcasts = db
    .prepare("SELECT name FROM devices WHERE auto_podcasts_enabled = 1")
    .all() as Array<{ name: string }>;

  const lines = [
    "## Auto Podcasts",
    `- Auto-download: ${autoPodcastEnabled ? `enabled (refresh every ${autoPodcastIntervalMin} min)` : "disabled"}`,
    `- Devices with auto-podcasts: ${devicesWithPodcasts.length > 0 ? devicesWithPodcasts.map((d) => d.name).join(", ") : "none"}`,
    `- Subscriptions: ${subs.length}`,
  ];

  if (subs.length > 0) {
    lines.push("", "### Subscriptions");
    for (const s of subs) {
      const autoLabel =
        s.auto_count === 0 ? "manual selection" : `auto latest ${s.auto_count}`;
      const statusLabel =
        s.failed_eps > 0
          ? "has errors"
          : s.pending_eps > 0
            ? "pending downloads"
            : s.ready_eps > 0
              ? "up-to-date"
              : "no episodes";
      lines.push(
        `- **${s.title}**${s.author ? ` by ${s.author}` : ""} — ${autoLabel}, ${s.ready_eps}/${s.total_eps} ready (${statusLabel}), last refreshed: ${s.last_refreshed_at ?? "never"}`
      );
    }
  }

  return lines.join("\n");
}

function buildActivityContext(db: Database.Database): string {
  const entries = db
    .prepare(
      `SELECT operation, detail, created_at
       FROM activity_log
       ORDER BY id DESC
       LIMIT 20`
    )
    .all() as Array<{
    operation: string;
    detail: string | null;
    created_at: string;
  }>;

  if (entries.length === 0) return "## Recent Activity\nNo recent activity.";

  const lines = ["## Recent Activity (last 20 events)"];
  for (const e of entries) {
    lines.push(
      `- [${e.created_at}] ${e.operation}${e.detail ? `: ${e.detail}` : ""}`
    );
  }
  return lines.join("\n");
}

const ASSISTANT_SYSTEM_PROMPT = `You are Rocksy, the user's music buddy inside iPodRocks, a personal music library and iPod sync app.
You're warm, enthusiastic, and genuinely passionate about music. Talk like a close friend who shares their love of music — not a corporate assistant reading from a database.
You have full knowledge of their setup: library (tracks, artists, albums, genres, playlists, listening history, harmonic data), all configured devices (models, codec profiles, sync settings, last sync dates), shadow libraries (transcoded copies), auto-podcast subscriptions and episode status, recent app activity, AND full knowledge of how iPodRocks works (all features, panels, settings, troubleshooting). Use all of this to give personal, helpful responses.

Personality guidelines:
- Be warm, casual, and personal. Use their name naturally if you know it from pinned memories.
- Show genuine excitement about their music taste — react to what they listen to like a friend would.
- When referencing their library data, weave it into conversation naturally. Say things like "You've got so much great stuff from **Radiohead**!" instead of "My records show 42 Radiohead tracks."
- When answering how-to or feature questions, be clear and direct — walk them through the steps in a friendly way.
- Use humor, enthusiasm, and personality. You're a music nerd who loves geeking out.
- Keep responses concise (1–4 sentences for music chat, step-by-step for how-to questions) but make every word feel human.
- If asked about creating a Savant (AI) playlist, point them to the Playlists > Savant tab.

Format your replies with **Markdown** for readability:
- Use **bold** for artist names, album titles, or key terms.
- Use bullet lists when suggesting multiple tracks, albums, or playlists.
- Use numbered lists for step-by-step guidance.
- Use *italic* for emphasis or song titles.
- Use \`code\` for technical terms (e.g. genres, key/BPM).
- Always wrap file paths and directory paths in \`code\` backticks (e.g. \`/Users/you/Music\`). Never write a path as plain text.
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

export interface AppPaths {
  userData: string;
  podcastsRoot: string;
  autoPodcastEnabled: boolean;
  autoPodcastIntervalMin: number;
}

function buildAppPathsContext(db: Database.Database, paths: AppPaths): string {
  const folders = db
    .prepare("SELECT name, path, content_type FROM library_folders ORDER BY content_type, name")
    .all() as Array<{ name: string; path: string; content_type: string }>;

  const lines: string[] = ["## App paths"];
  lines.push(`- App data directory: ${paths.userData}`);
  lines.push(`- Database: ${paths.userData}/ipodrock.db`);
  lines.push(`- Preferences file: ${paths.userData}/ipodrocks-prefs.json`);
  lines.push(`- Auto-podcasts storage: ${paths.podcastsRoot}`);

  if (folders.length > 0) {
    lines.push("", "## Library folders");
    for (const f of folders) {
      lines.push(`- [${f.content_type}] ${f.name}: ${f.path}`);
    }
  } else {
    lines.push("", "## Library folders", "- No library folders configured yet.");
  }

  return lines.join("\n");
}

export async function sendAssistantMessage(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  db: Database.Database,
  config: OpenRouterConfig,
  appPaths: AppPaths
): Promise<string> {
  // F9: Cache the expensive context queries with a 5-minute TTL
  const now = Date.now();
  if (!libraryContextCache || now - libraryContextCache.ts > LIBRARY_CONTEXT_TTL_MS) {
    libraryContextCache = { text: buildLibraryContext(db), ts: now };
  }
  if (!playlistInstructionsCache || now - playlistInstructionsCache.ts > LIBRARY_CONTEXT_TTL_MS) {
    playlistInstructionsCache = { text: buildPlaylistInstructions(db), ts: now };
  }
  if (!appDataContextCache || now - appDataContextCache.ts > LIBRARY_CONTEXT_TTL_MS) {
    const devicesCtx = buildDevicesContext(db);
    const shadowCtx = buildShadowLibrariesContext(db);
    const podcastCtx = buildAutoPodcastsContext(
      db,
      appPaths.autoPodcastEnabled,
      appPaths.autoPodcastIntervalMin
    );
    appDataContextCache = {
      text: `${devicesCtx}\n\n${shadowCtx}\n\n${podcastCtx}`,
      ts: now,
    };
  }
  const libraryContext = libraryContextCache.text;
  const playlistInstructions = playlistInstructionsCache.text;
  const appDataContext = appDataContextCache.text;
  const appPathsContext = buildAppPathsContext(db, appPaths);
  const activityContext = buildActivityContext(db);

  const { text: pinnedText, count: pinnedCount } =
    buildPinnedMemoriesContext(db);
  const memoryInstructions = buildMemoryInstructions(pinnedText, pinnedCount);

  const llmMessages: OpenRouterMessage[] = [
    {
      role: "system",
      content: `${ASSISTANT_SYSTEM_PROMPT}\n<app_docs>\n${APP_DOCS}\n</app_docs>`,
    },
    {
      role: "system",
      content: `${memoryInstructions}\n${playlistInstructions}\n<library_context>\n${libraryContext}\n</library_context>\n<app_data>\n${appDataContext}\n</app_data>\n<app_paths>\n${appPathsContext}\n</app_paths>\n<dashboard>\n${activityContext}\n</dashboard>\n\nUse the app_docs to answer how-to and feature questions about iPodRocks. Use library_context for the music collection. Use app_data for devices, shadow libraries, and podcast configuration. Use app_paths for file locations. Use dashboard for recent activity. If something is genuinely not covered, say so.`,
    },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  return callOpenRouter(llmMessages, config, false);
}
