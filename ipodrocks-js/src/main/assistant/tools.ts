/**
 * AI tool registry for Rocksy's tool-calling loop.
 *
 * Tools are tiered by kind:
 *  - "read"              — safe, run inline
 *  - "write-safe"        — non-destructive mutations, run inline
 *  - "write-destructive" — deletions / device ops / folder changes; require user confirm
 *
 * Each tool's run() calls the same core functions used by the IPC handlers.
 */

import type Database from "better-sqlite3";
import type { Library } from "../library/library";
import type { PlaylistCore } from "../playlists/playlist-core";
import type { DevicesCore } from "../devices/devices-core";
import type { PodcastSearchResult, SmartPlaylistRule } from "../../shared/types";
import type { ToolDefinition } from "../llm/openRouterClient";
import {
  listSubscriptions,
  subscribe as podcastSubscribe,
  listEpisodes,
} from "../podcasts/podcast-subscriptions";
import { searchPodcasts } from "../podcasts/podcast-index-client";
import { importFeed } from "../podcasts/podcast-feed-import";
import { searchAudiobooks } from "../audiobooks/librivox-client";
import {
  listSubscriptions as listAudiobookSubscriptions,
  subscribe as audiobookSubscribeFn,
  unsubscribe as audiobookUnsubscribeFn,
} from "../audiobooks/audiobook-subscriptions";
import { downloadCover as downloadAudiobookCover } from "../audiobooks/audiobook-cover";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "./assistantChat";
import {
  getAvailableGeniusTypes,
  generateGeniusPlaylistFromDb,
} from "../playlists/genius-engine";

export interface AiToolContext {
  db: Database.Database;
  getLibrary: () => Library;
  getPlaylistCore: () => PlaylistCore;
  getDevicesCore: () => DevicesCore;
  getPodcastIndexConfig: () => { apiKey: string; apiSecret: string } | null;
}

export type AiToolKind = "read" | "write-safe" | "write-destructive";

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: AiToolKind;
  /** Human-readable description of what this call will do (used in confirm gate). */
  summarize: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: AiToolContext) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Individual tool definitions
// ---------------------------------------------------------------------------

const library_search_tracks: AiTool = {
  name: "library_search_tracks",
  description: "Search the music library for tracks matching a query string. Searches title, artist, and album fields.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term (partial match on title, artist, or album)" },
      content_type: {
        type: "string",
        enum: ["music", "podcast", "audiobook"],
        description: "Content type to search (default: music)",
      },
      limit: { type: "number", description: "Max results to return (default: 20, max: 100)" },
    },
    required: ["query"],
  },
  kind: "read",
  summarize: (a) => `Search library for "${a.query}"`,
  async run(args, ctx) {
    const query = String(args.query ?? "");
    const contentType = String(args.content_type ?? "music");
    const limit = Math.min(Number(args.limit ?? 20), 100);
    const like = `%${query}%`;
    return ctx.db
      .prepare(
        `SELECT t.id, t.title, a.name as artist, al.title as album, g.name as genre, t.content_type
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         LEFT JOIN genres g ON t.genre_id = g.id
         WHERE t.content_type = ?
           AND (t.title LIKE ? OR a.name LIKE ? OR al.title LIKE ?)
         ORDER BY a.name, al.title, t.track_number
         LIMIT ?`
      )
      .all(contentType, like, like, like, limit);
  },
};

const library_list_albums: AiTool = {
  name: "library_list_albums",
  description: "List albums in the music library, optionally filtered by artist name.",
  parameters: {
    type: "object",
    properties: {
      artist_filter: { type: "string", description: "Filter by artist name (partial match)" },
    },
  },
  kind: "read",
  summarize: () => "List albums",
  async run(args, ctx) {
    const albums = ctx.getPlaylistCore().getAlbums();
    if (args.artist_filter) {
      const f = String(args.artist_filter).toLowerCase();
      return albums.filter((a) => a.artist?.toLowerCase().includes(f));
    }
    return albums;
  },
};

const library_list_artists: AiTool = {
  name: "library_list_artists",
  description: "List all artists in the music library.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List artists",
  async run(_args, ctx) {
    return ctx.getPlaylistCore().getArtists();
  },
};

const library_list_genres: AiTool = {
  name: "library_list_genres",
  description: "List all genres in the music library.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List genres",
  async run(_args, ctx) {
    return ctx.getPlaylistCore().getGenres();
  },
};

const podcast_search: AiTool = {
  name: "podcast_search",
  description: "Search the Podcast Index for podcasts to subscribe to. Returns feed details including feedUrl needed for subscribing.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term (podcast name, topic, or host)" },
    },
    required: ["query"],
  },
  kind: "read",
  summarize: (a) => `Search podcasts for "${a.query}"`,
  async run(args, ctx) {
    const config = ctx.getPodcastIndexConfig();
    if (!config) return { error: "Podcast Index credentials not configured" };
    return searchPodcasts(String(args.query), config.apiKey, config.apiSecret);
  },
};

const podcast_list_subscriptions: AiTool = {
  name: "podcast_list_subscriptions",
  description: "List all currently subscribed podcasts.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List podcast subscriptions",
  async run(_args, ctx) {
    return listSubscriptions(ctx.db);
  },
};

const podcast_list_episodes: AiTool = {
  name: "podcast_list_episodes",
  description: "List episodes for a specific podcast subscription.",
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "number", description: "The subscription ID (from podcast_list_subscriptions)" },
    },
    required: ["subscription_id"],
  },
  kind: "read",
  summarize: (a) => `List episodes for subscription #${a.subscription_id}`,
  async run(args, ctx) {
    const subId = Number(args.subscription_id);
    if (!Number.isInteger(subId) || subId <= 0) throw new Error("Invalid subscription_id");
    return listEpisodes(ctx.db, subId);
  },
};

const device_list: AiTool = {
  name: "device_list",
  description: "List all configured devices (iPods/DAPs) and their basic settings.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List devices",
  async run(_args, ctx) {
    return ctx.getDevicesCore().getDevices().map((d) => ({
      id: d.profile.id,
      name: d.profile.name,
      mountPath: d.profile.mountPath,
      model: d.profile.modelName,
      lastSyncDate: d.profile.lastSyncDate,
    }));
  },
};

const playlist_create_smart: AiTool = {
  name: "playlist_create_smart",
  description: "Create a smart playlist filtered by genre, artist, or album. Use library_list_genres/artists/albums to get valid IDs first.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Playlist name" },
      rules: {
        type: "array",
        description: "Filter rules (multiple same-type rules = OR, different types = AND)",
        items: {
          type: "object",
          properties: {
            ruleType: { type: "string", enum: ["genre", "artist", "album"] },
            targetId: { type: "number", description: "ID from the relevant list" },
            targetLabel: { type: "string", description: "Display name (for reference)" },
          },
          required: ["ruleType", "targetId", "targetLabel"],
        },
      },
      track_limit: { type: "number", description: "Maximum tracks in the playlist (10–300, default 50)" },
    },
    required: ["name", "rules"],
  },
  kind: "write-safe",
  summarize: (a) => `Create smart playlist "${a.name}"`,
  async run(args, ctx) {
    const name = String(args.name ?? "");
    if (!name) throw new Error("Playlist name is required");
    const rules = (args.rules as Array<{ ruleType: string; targetId: number; targetLabel: string }>) ?? [];
    if (rules.length === 0) throw new Error("At least one rule is required");

    const stmtForType: Record<string, ReturnType<typeof ctx.db.prepare>> = {
      genre: ctx.db.prepare("SELECT 1 FROM genres WHERE id = ?"),
      artist: ctx.db.prepare("SELECT 1 FROM artists WHERE id = ?"),
      album: ctx.db.prepare("SELECT 1 FROM albums WHERE id = ?"),
    };
    const validatedRules: SmartPlaylistRule[] = rules.filter((r) => {
      const stmt = stmtForType[r.ruleType];
      return stmt ? stmt.get(r.targetId) != null : false;
    });
    if (validatedRules.length === 0) throw new Error("No valid rule IDs — use library_list_genres/artists/albums to get real IDs");

    const trackLimit = args.track_limit ? Math.min(Math.max(Number(args.track_limit), 10), 300) : 50;
    ctx.getPlaylistCore().createSmartPlaylist(name, validatedRules, "", trackLimit);
    logActivity(ctx.db, "playlist_generated", `Smart (AI): ${name}`);
    invalidateAssistantCache();
    return { name, created: true };
  },
};

const playlist_create_genius: AiTool = {
  name: "playlist_create_genius",
  description: "Create a Genius playlist based on listening history (most played, favorites, late night, etc.).",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Playlist name" },
      genius_type: {
        type: "string",
        description: "Genius playlist type (use the value field from the available types)",
      },
      max_tracks: { type: "number", description: "Maximum tracks (default 25)" },
      artist: { type: "string", description: "For deep_dive type: the artist name" },
      target_month: { type: "number", description: "For time_capsule: month (1-12)" },
      target_year: { type: "number", description: "For time_capsule: year (e.g. 2022)" },
      range_start_months_ago: { type: "number", description: "For golden_era: start of range in months ago" },
      range_end_months_ago: { type: "number", description: "For golden_era: end of range in months ago" },
    },
    required: ["name", "genius_type"],
  },
  kind: "write-safe",
  summarize: (a) => `Create Genius playlist "${a.name}" (${a.genius_type})`,
  async run(args, ctx) {
    const name = String(args.name ?? "");
    const geniusType = String(args.genius_type ?? "");
    if (!name || !geniusType) throw new Error("name and genius_type are required");

    const validTypes = getAvailableGeniusTypes(ctx.db).map((t) => t.value);
    if (!validTypes.includes(geniusType)) {
      throw new Error(`Invalid genius_type "${geniusType}". Valid values: ${validTypes.join(", ")}`);
    }

    const opts = {
      maxTracks: args.max_tracks ? Number(args.max_tracks) : 25,
      artist: args.artist ? String(args.artist) : undefined,
      targetMonth: args.target_month ? Number(args.target_month) : undefined,
      targetYear: args.target_year ? Number(args.target_year) : undefined,
      rangeStartMonthsAgo: args.range_start_months_ago ? Number(args.range_start_months_ago) : undefined,
      rangeEndMonthsAgo: args.range_end_months_ago ? Number(args.range_end_months_ago) : undefined,
    };

    const result = generateGeniusPlaylistFromDb(geniusType, ctx.db, opts);
    const trackIds = result.tracks.map((t) => t.id);
    if (trackIds.length === 0) throw new Error("No tracks matched the genius criteria");

    ctx.getPlaylistCore().createGeniusPlaylist(geniusType, trackIds, null, opts.maxTracks, name);
    logActivity(ctx.db, "playlist_generated", `Genius (AI): ${name} (${trackIds.length} tracks)`);
    invalidateAssistantCache();
    return { name, created: true, trackCount: trackIds.length };
  },
};

const podcast_subscribe: AiTool = {
  name: "podcast_subscribe",
  description: "Subscribe to a podcast by its feed details. Use podcast_search first to get the feed details.",
  parameters: {
    type: "object",
    properties: {
      feed_id: { type: "number", description: "Podcast Index feed ID (from search results)" },
      title: { type: "string", description: "Podcast title" },
      author: { type: "string", description: "Podcast author" },
      description: { type: "string", description: "Podcast description" },
      image_url: { type: "string", description: "Podcast image URL" },
      feed_url: { type: "string", description: "RSS feed URL" },
      episode_count: { type: "number", description: "Number of episodes" },
    },
    required: ["feed_id", "title", "feed_url"],
  },
  kind: "write-safe",
  summarize: (a) => `Subscribe to podcast "${a.title}"`,
  async run(args, ctx) {
    const feed: PodcastSearchResult = {
      feedId: Number(args.feed_id),
      title: String(args.title),
      author: String(args.author ?? ""),
      description: String(args.description ?? ""),
      imageUrl: String(args.image_url ?? ""),
      feedUrl: String(args.feed_url),
      episodeCount: Number(args.episode_count ?? 0),
    };
    const result = podcastSubscribe(ctx.db, feed);
    invalidateAssistantCache();
    logActivity(ctx.db, "podcast_subscribed", `AI subscribed to: ${feed.title}`);
    return result;
  },
};

const device_check: AiTool = {
  name: "device_check",
  description: "Analyze a device's sync status — compares the library to device contents and reports what would be added, removed, or skipped. Does not modify the device.",
  parameters: {
    type: "object",
    properties: {
      device_id: { type: "number", description: "Device ID (from device_list)" },
    },
    required: ["device_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Check sync status for device #${a.device_id}`,
  async run(args, ctx) {
    const deviceId = Number(args.device_id);
    if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error("Invalid device_id");
    const device = ctx.getDevicesCore().getDeviceById(deviceId);
    if (!device) throw new Error(`Device #${deviceId} not found`);
    return { deviceId, name: device.profile.name, note: "Full check requires mounting the device — please use the Devices panel for a detailed sync analysis." };
  },
};

const podcast_download_now: AiTool = {
  name: "podcast_download_now",
  description: "Refresh and download the latest episodes for a podcast subscription.",
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "number", description: "Subscription ID (from podcast_list_subscriptions)" },
    },
    required: ["subscription_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Download latest episodes for subscription #${a.subscription_id}`,
  async run(args, ctx) {
    const subId = Number(args.subscription_id);
    if (!Number.isInteger(subId) || subId <= 0) throw new Error("Invalid subscription_id");
    const subs = listSubscriptions(ctx.db);
    const sub = subs.find((s) => s.id === subId);
    if (!sub) throw new Error(`Subscription #${subId} not found`);
    const config = ctx.getPodcastIndexConfig();
    if (!config) return { error: "Podcast Index credentials not configured" };

    const { refreshSubscription } = await import("../podcasts/podcast-refresh");
    await refreshSubscription(ctx.db, subId, config.apiKey, config.apiSecret);
    logActivity(ctx.db, "podcast_downloaded", `AI refreshed: ${sub.title}`);
    return { ok: true, title: sub.title };
  },
};

const podcast_delete_episodes: AiTool = {
  name: "podcast_delete_episodes",
  description: "Delete downloaded podcast episodes by their IDs.",
  parameters: {
    type: "object",
    properties: {
      episode_ids: {
        type: "array",
        items: { type: "number" },
        description: "Episode IDs to delete (from podcast_list_episodes)",
      },
    },
    required: ["episode_ids"],
  },
  kind: "write-destructive",
  summarize: (a) => `Delete ${(a.episode_ids as number[]).length} podcast episode(s)`,
  async run(args, ctx) {
    const ids = (args.episode_ids as number[]) ?? [];
    if (ids.length === 0) throw new Error("No episode IDs provided");
    const { deleteEpisodes } = await import("../podcasts/podcast-subscriptions");
    deleteEpisodes(ctx.db, ids);
    logActivity(ctx.db, "podcast_episodes_deleted", `AI deleted ${ids.length} episode(s)`);
    return { deleted: ids.length };
  },
};

const library_add_folder: AiTool = {
  name: "library_add_folder",
  description: "Add a folder to the music library. The folder must exist on disk.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Friendly name for this library folder" },
      path: { type: "string", description: "Absolute path to the folder" },
      content_type: {
        type: "string",
        enum: ["music", "podcast", "audiobook"],
        description: "Content type of files in this folder",
      },
    },
    required: ["name", "path", "content_type"],
  },
  kind: "write-destructive",
  summarize: (a) => `Add library folder "${a.name}" at ${a.path}`,
  async run(args, ctx) {
    const name = String(args.name ?? "");
    const folderPath = String(args.path ?? "");
    const contentType = String(args.content_type ?? "music") as "music" | "podcast" | "audiobook";
    if (!name || !folderPath) throw new Error("name and path are required");

    const { validateFolderPathForTool } = await import("./tool-helpers");
    const validated = validateFolderPathForTool(folderPath);
    if ("error" in validated) throw new Error(validated.error);

    const result = ctx.getLibrary().addLibraryFolder(name, validated.path, contentType);
    logActivity(ctx.db, "add_folder", `AI added folder: ${name} (${validated.path})`);
    return result;
  },
};

const library_remove_folder: AiTool = {
  name: "library_remove_folder",
  description: "Remove a library folder by its ID. Obtain folder IDs from the library folders list.",
  parameters: {
    type: "object",
    properties: {
      folder_id: { type: "number", description: "Library folder ID to remove" },
    },
    required: ["folder_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Remove library folder #${a.folder_id}`,
  async run(args, ctx) {
    const folderId = Number(args.folder_id);
    if (!Number.isInteger(folderId) || folderId <= 0) throw new Error("Invalid folder_id");
    const ok = ctx.getLibrary().removeLibraryFolder(folderId, true);
    if (!ok) throw new Error("Folder not found or could not be removed");
    logActivity(ctx.db, "remove_folder", `AI removed folder #${folderId}`);
    return { removed: true };
  },
};

const playlist_list_broken: AiTool = {
  name: "playlist_list_broken",
  description: "List all playlists that reference tracks which no longer exist in the library (broken playlists). Returns each broken playlist's ID, name, type, missing track count, and total item count.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List broken playlists with missing tracks",
  async run(_args, ctx) {
    return ctx.getPlaylistCore().getBrokenPlaylists();
  },
};

const playlist_repair: AiTool = {
  name: "playlist_repair",
  description: "Repair a broken playlist by removing all items that reference tracks no longer in the library. Positions are renumbered. Use playlist_list_broken first to get playlist IDs.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "number", description: "ID of the broken playlist to repair" },
    },
    required: ["playlist_id"],
  },
  kind: "write-safe",
  summarize: (a) => `Repair playlist #${a.playlist_id} by removing missing tracks`,
  async run(args, ctx) {
    const id = Number(args.playlist_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid playlist_id");
    ctx.getPlaylistCore().repairPlaylist(id);
    invalidateAssistantCache();
    logActivity(ctx.db, "playlist_repaired", `AI repaired playlist #${id}`);
    return { repaired: true };
  },
};

const playlist_delete: AiTool = {
  name: "playlist_delete",
  description: "Delete a playlist by its ID.",
  parameters: {
    type: "object",
    properties: {
      playlist_id: { type: "number", description: "Playlist ID to delete" },
    },
    required: ["playlist_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Delete playlist #${a.playlist_id}`,
  async run(args, ctx) {
    const id = Number(args.playlist_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid playlist_id");
    ctx.getPlaylistCore().deletePlaylist(id);
    invalidateAssistantCache();
    logActivity(ctx.db, "playlist_deleted", `AI deleted playlist #${id}`);
    return { deleted: true };
  },
};

const device_remove: AiTool = {
  name: "device_remove",
  description: "Remove a device configuration by its ID. The device will no longer appear in iPodRocks but no files are deleted from it.",
  parameters: {
    type: "object",
    properties: {
      device_id: { type: "number", description: "Device ID to remove (from device_list)" },
    },
    required: ["device_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Remove device #${a.device_id} from iPodRocks`,
  async run(args, ctx) {
    const deviceId = Number(args.device_id);
    if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error("Invalid device_id");
    const device = ctx.getDevicesCore().getDeviceById(deviceId);
    if (!device) throw new Error(`Device #${deviceId} not found`);
    const name = device.profile.name;
    const ok = ctx.getDevicesCore().deleteDevice(deviceId);
    if (!ok) throw new Error(`Failed to remove device #${deviceId}`);
    invalidateAssistantCache();
    logActivity(ctx.db, "update_device", `AI removed device: ${name}`);
    return { removed: true, name };
  },
};

const device_sync: AiTool = {
  name: "device_sync",
  description: "Start a sync for a device using its saved sync preferences. Opens the Sync panel where you can watch progress.",
  parameters: {
    type: "object",
    properties: {
      device_id: { type: "number", description: "Device ID to sync (from device_list)" },
    },
    required: ["device_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Sync device #${a.device_id} with current sync preferences`,
  async run(args, ctx) {
    const deviceId = Number(args.device_id);
    if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error("Invalid device_id");
    const device = ctx.getDevicesCore().getDeviceById(deviceId);
    if (!device) throw new Error(`Device #${deviceId} not found`);
    const { BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("assistant:triggerSync", { deviceId });
    }
    return { ok: true, deviceName: device.profile.name, message: "Sync triggered — I've navigated to the Sync panel and selected your device. Press Start Sync when you're ready." };
  },
};

const library_scan: AiTool = {
  name: "library_scan",
  description: "Scan all library folders to find new, changed, or removed files. Triggers the scan in the Library panel.",
  parameters: { type: "object", properties: {} },
  kind: "write-destructive",
  summarize: () => "Scan library folders for new and changed files",
  async run(_args, _ctx) {
    const { BrowserWindow } = await import("electron");
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send("assistant:triggerLibraryScan");
    }
    return { ok: true, message: "Library scan triggered — I've navigated to the Library panel and started the scan." };
  },
};

const podcast_add_by_url: AiTool = {
  name: "podcast_add_by_url",
  description: "Subscribe to a podcast using an RSS feed URL or a podcast website URL. No API key required. Works for any public podcast feed.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The RSS feed URL or podcast website URL to subscribe to" },
    },
    required: ["url"],
  },
  kind: "write-safe",
  summarize: (a) => `Add podcast from URL: ${a.url}`,
  async run(args, ctx) {
    const result = await importFeed(ctx.db, String(args.url));
    invalidateAssistantCache();
    logActivity(ctx.db, "podcast_subscribed", `AI subscribed to: ${result.title}`);
    return result;
  },
};

// ---------------------------------------------------------------------------
// Audiobook tools (LibriVox)
// ---------------------------------------------------------------------------

const audiobook_search: AiTool = {
  name: "audiobook_search",
  description: "Search LibriVox for free public-domain audiobooks. Returns title, author, chapter count, duration, and other details. No API key required.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term (book title or author name)" },
    },
    required: ["query"],
  },
  kind: "read",
  summarize: (a) => `Search LibriVox for "${a.query}"`,
  async run(args) {
    return searchAudiobooks(String(args.query));
  },
};

const audiobook_list_subscriptions: AiTool = {
  name: "audiobook_list_subscriptions",
  description: "List all extra audiobooks the user has added from LibriVox.",
  parameters: { type: "object", properties: {} },
  kind: "read",
  summarize: () => "List extra audiobook subscriptions",
  async run(_args, ctx) {
    return listAudiobookSubscriptions(ctx.db);
  },
};

const audiobook_subscribe: AiTool = {
  name: "audiobook_subscribe",
  description: "Add a LibriVox audiobook so it appears in the Sync panel's Audiobooks list. Chapters download automatically when the user syncs their device.",
  parameters: {
    type: "object",
    properties: {
      librivox_id: { type: "number", description: "The LibriVox book ID (from audiobook_search results)" },
      title: { type: "string", description: "Book title" },
      author: { type: "string", description: "Author name (optional)" },
      rss_url: { type: "string", description: "The book's RSS/chapter feed URL" },
      description: { type: "string", description: "Book description (optional)" },
      language: { type: "string", description: "Language (optional)" },
      num_sections: { type: "number", description: "Number of chapters" },
      total_seconds: { type: "number", description: "Total duration in seconds" },
    },
    required: ["librivox_id", "title", "rss_url"],
  },
  kind: "write-safe",
  summarize: (a) => `Add audiobook: ${a.title}`,
  async run(args, ctx) {
    const result = {
      librivoxId: Number(args.librivox_id),
      title: String(args.title),
      author: args.author != null ? String(args.author) : null,
      rssUrl: String(args.rss_url),
      description: args.description != null ? String(args.description) : null,
      imageUrl: null,
      language: args.language != null ? String(args.language) : null,
      numSections: Number(args.num_sections ?? 0),
      totalSeconds: Number(args.total_seconds ?? 0),
    };
    const sub = await audiobookSubscribeFn(ctx.db, result);
    invalidateAssistantCache();
    logActivity(ctx.db, "audiobook_subscribed", `AI added audiobook: ${result.title}`);
    return sub;
  },
};

const audiobook_refresh_cover: AiTool = {
  name: "audiobook_refresh_cover",
  description: "Fetch or re-fetch the cover image for an extra audiobook. Use this if a book's cover is missing or wrong.",
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "number", description: "The subscription ID (from audiobook_list_subscriptions)" },
    },
    required: ["subscription_id"],
  },
  kind: "write-safe",
  summarize: (a) => `Refresh cover for audiobook subscription #${a.subscription_id}`,
  async run(args, ctx) {
    const subId = Number(args.subscription_id);
    if (!Number.isInteger(subId) || subId <= 0) throw new Error("Invalid subscription_id");
    await downloadAudiobookCover(ctx.db, subId);
    return { ok: true };
  },
};

const audiobook_unsubscribe: AiTool = {
  name: "audiobook_unsubscribe",
  description: "Remove an extra audiobook. This deletes all locally downloaded chapter files and removes the book from the Sync panel.",
  parameters: {
    type: "object",
    properties: {
      subscription_id: { type: "number", description: "The subscription ID (from audiobook_list_subscriptions)" },
    },
    required: ["subscription_id"],
  },
  kind: "write-destructive",
  summarize: (a) => `Remove extra audiobook subscription #${a.subscription_id}`,
  async run(args, ctx) {
    const subId = Number(args.subscription_id);
    if (!Number.isInteger(subId) || subId <= 0) throw new Error("Invalid subscription_id");
    audiobookUnsubscribeFn(ctx.db, subId);
    invalidateAssistantCache();
    logActivity(ctx.db, "audiobook_unsubscribed", `AI removed audiobook subscription #${subId}`);
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const AI_TOOLS: AiTool[] = [
  library_search_tracks,
  library_list_albums,
  library_list_artists,
  library_list_genres,
  podcast_search,
  podcast_list_subscriptions,
  podcast_list_episodes,
  device_list,
  playlist_create_smart,
  playlist_create_genius,
  podcast_subscribe,
  podcast_add_by_url,
  device_check,
  device_remove,
  device_sync,
  library_scan,
  podcast_download_now,
  podcast_delete_episodes,
  audiobook_search,
  audiobook_list_subscriptions,
  audiobook_subscribe,
  audiobook_refresh_cover,
  audiobook_unsubscribe,
  library_add_folder,
  library_remove_folder,
  playlist_list_broken,
  playlist_repair,
  playlist_delete,
];

export function getToolByName(name: string): AiTool | undefined {
  return AI_TOOLS.find((t) => t.name === name);
}

export function buildToolDefinitions(): ToolDefinition[] {
  return AI_TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
