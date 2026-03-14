import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from "electron";

/** Builds path→track maps for music, podcast, audiobook from a single getTracks call. */
function buildLibraryTrackMaps(lib: Library): {
  music: Record<string, Record<string, unknown>>;
  podcast: Record<string, Record<string, unknown>>;
  audiobook: Record<string, Record<string, unknown>>;
} {
  const all = lib.getTracks();
  const music: Record<string, Record<string, unknown>> = {};
  const podcast: Record<string, Record<string, unknown>> = {};
  const audiobook: Record<string, Record<string, unknown>> = {};
  for (const t of all) {
    const rec = t as unknown as Record<string, unknown>;
    const ct = (t.contentType ?? "music") as string;
    if (ct === "music") music[t.path] = rec;
    else if (ct === "podcast") podcast[t.path] = rec;
    else if (ct === "audiobook") audiobook[t.path] = rec;
  }
  return { music, podcast, audiobook };
}

/** Validates a folder path for library operations. Returns resolved path or error. */
function validateFolderPath(rawPath: string): { path: string } | { error: string } {
  if (!rawPath || typeof rawPath !== "string") {
    return { error: "Invalid path" };
  }
  const resolved = path.resolve(rawPath.trim());
  if (resolved.split(path.sep).includes("..")) {
    return { error: "Path must not contain parent traversal" };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: "Path is not a directory" };
    }
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }
  return { path: resolved };
}

import {
  AddDeviceConfig,
  GeniusGenerateOptions,
  MatchedPlayEvent,
  SyncOptions,
  SmartPlaylistRule,
} from "../shared/types";
import { DevicesCore } from "./devices/devices-core";
import { Library } from "./library/library";
import { LibraryScanner } from "./library/library-scanner";
import { PlaylistCore } from "./playlists/playlist-core";
import { parseRockboxPlaybackLog } from "./playlists/rockbox-log-parser";
import { readAndIngestPlaybackLog } from "./playlists/playback-log-ingest";
import {
  buildAnalysisSummary,
  buildAnalysisSummaryFromDb,
  generateGeniusPlaylist,
  generateGeniusPlaylistFromDb,
  getArtistsFromEvents,
  getArtistsFromPlaybackStats,
  getAvailableGeniusTypes,
  matchEventsToLibrary,
} from "./playlists/genius-engine";
import {
  runSync,
  RunSyncOptions,
  buildLibraryDestMap,
  getProfileCodecExt,
  removeExtraTracks,
} from "./sync/sync-core";
import { compareLibraries } from "./sync/name-size-sync";
import { isMpcencAvailable } from "./utils/mpcenc";
import {
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  getOpenRouterConfig,
  setOpenRouterConfig,
  getHarmonicPrefs,
  setHarmonicPrefs,
  type HarmonicPrefs,
} from "./utils/prefs";
import { generateSavantPlaylist } from "./savant/savantEngine";
import {
  startMoodChat,
  processMoodChatTurn,
  type MoodChatState,
} from "./savant/moodChat";
import {
  startSavantPlaylistChat,
  processSavantPlaylistChatTurn,
  type SavantPlaylistChatState,
} from "./savant/savantPlaylistChat";
import {
  sendAssistantMessage,
  loadAssistantHistory,
  loadNonPinnedHistory,
  saveAssistantMessages,
  clearAssistantHistory,
  parseActionTags,
  pinMessages,
  unpinMessages,
  getPinnedCount,
  MAX_PINNED_MEMORIES,
} from "./assistant/assistantChat";
import { randomUUID } from "crypto";
import { logActivity, getRecentActivity } from "./activity/activity-logger";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let library: Library | null = null;
let devicesCore: DevicesCore | null = null;
let playlistCore: PlaylistCore | null = null;
let activeSyncAbort: AbortController | null = null;
let activeScanAbort: AbortController | null = null;
let activeShadowBuildAbort: AbortController | null = null;
let activeBackfillAbort: AbortController | null = null;

/** In-memory cache of matched playback events keyed by device ID. */
const geniusEventsCache = new Map<number, MatchedPlayEvent[]>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CAP = 50;

/** Ephemeral mood chat sessions keyed by session ID. */
const moodChatSessions = new Map<string, { state: MoodChatState; createdAt: number }>();

/** Ephemeral Savant playlist chat sessions keyed by session ID. */
const savantPlaylistChatSessions = new Map<
  string,
  { state: SavantPlaylistChatState; createdAt: number }
>();

function cleanupChatSessions<T>(
  map: Map<string, { state: T; createdAt: number }>
): void {
  const now = Date.now();
  for (const [id, entry] of map.entries()) {
    if (now - entry.createdAt > SESSION_TTL_MS) map.delete(id);
  }
  while (map.size > SESSION_CAP) {
    const oldest = [...map.entries()].reduce((a, b) =>
      a[1].createdAt < b[1].createdAt ? a : b
    );
    map.delete(oldest[0]);
  }
}

function getLibrary(): Library {
  if (!library) {
    library = new Library();
    devicesCore = new DevicesCore(library.getConnection());
  }
  return library;
}

function getPlaylistCore(): PlaylistCore {
  if (!playlistCore) {
    playlistCore = new PlaylistCore(getLibrary().getConnection());
  }
  return playlistCore;
}

function getDevicesCore(): DevicesCore {
  const lib = getLibrary();
  if (!devicesCore) {
    devicesCore = new DevicesCore(lib.getConnection());
  }
  return devicesCore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>;

function safe(fn: Handler): Handler {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      console.error(`[ipc] ${message}`);
      return { error: message };
    }
  };
}

export function registerIpcHandlers(): void {
  // ---- App prefs and tool availability ----
  ipcMain.handle(
    "app:isMpcencAvailable",
    safe(async () => ({ available: isMpcencAvailable() }))
  );
  ipcMain.handle(
    "app:getMpcRemindDisabled",
    safe(async () => ({ disabled: getMpcRemindDisabled() }))
  );
  ipcMain.handle(
    "app:setMpcRemindDisabled",
    safe(async (_event, disabled: boolean) => {
      setMpcRemindDisabled(disabled);
      return undefined;
    })
  );

  // ---- Genius Playlists (register early so they are always available) ----
  ipcMain.handle(
    "genius:analyze",
    safe(async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      const allEvents = parseRockboxPlaybackLog(device.mountPath);
      const db = getLibrary().getConnection();
      const matched = matchEventsToLibrary(allEvents, db);
      geniusEventsCache.set(deviceId, matched);

      const summary = buildAnalysisSummary(allEvents, matched);
      const artists = getArtistsFromEvents(matched);
      return { summary, artists };
    })
  );

  ipcMain.handle(
    "genius:getSummaryFromDb",
    safe(async () => {
      const summary = buildAnalysisSummaryFromDb(getLibrary().getConnection());
      const artists = getArtistsFromPlaybackStats(getLibrary().getConnection());
      return { summary, artists };
    })
  );

  ipcMain.handle(
    "genius:types",
    safe(async () => getAvailableGeniusTypes(getLibrary().getConnection()))
  );

  ipcMain.handle(
    "genius:generate",
    safe(async (
      _event,
      deviceId: number | null,
      geniusType: string,
      opts: GeniusGenerateOptions
    ) => {
      const db = getLibrary().getConnection();
      const cached =
        deviceId != null ? geniusEventsCache.get(deviceId) : undefined;
      if (cached && cached.length > 0) {
        return generateGeniusPlaylist(geniusType, cached, db, opts);
      }
      return generateGeniusPlaylistFromDb(geniusType, db, opts);
    })
  );

  ipcMain.handle(
    "genius:save",
    safe(async (
      _event,
      name: string,
      geniusType: string,
      deviceId: number | null,
      trackIds: number[],
      trackLimit: number
    ) => {
      const core = getPlaylistCore();
      const id = core.createGeniusPlaylist(
        geniusType,
        trackIds,
        deviceId ?? null,
        trackLimit,
        name
      );
      logActivity(
        getLibrary().getConnection(),
        "playlist_generated",
        `Genius: ${name} (${trackIds.length} tracks)`
      );
      return core.getPlaylistById(id);
    })
  );

  // ---- Dialog -----------------------------------------------------------

  ipcMain.handle(
    "dialog:pickFolder",
    safe(async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    })
  );

  // ---- Library ----------------------------------------------------------

  ipcMain.handle(
    "library:scan",
    safe(async (event, payload: { folders: Array<{ name: string; path: string; contentType: string }> }) => {
      const lib = getLibrary();
      const scanner = new LibraryScanner(lib.getConnection());
      activeScanAbort = new AbortController();
      const harmonicPrefs = getHarmonicPrefs();

      let totalAdded = 0;
      let totalProcessed = 0;

      const allErrors: string[] = [];
      const allAdded: string[] = [];
      const allUpdated: string[] = [];
      const allRemoved: string[] = [];
      try {
        for (const folder of payload.folders) {
          const validated = validateFolderPath(folder.path);
          if ("error" in validated) {
            allErrors.push(`${folder.name}: ${validated.error}`);
            continue;
          }
          const result = await scanner.scanFolder(
            validated.path,
            folder.contentType,
            (progress) => event.sender.send("scan:progress", progress),
            activeScanAbort.signal,
            { scanHarmonicData: harmonicPrefs.scanHarmonicData }
          );
          totalAdded += result.filesAdded;
          totalProcessed += result.filesProcessed;
          if (result.errors?.length) allErrors.push(...result.errors);
          if (result.addedTrackPaths?.length) allAdded.push(...result.addedTrackPaths);
          if (result.updatedTrackPaths?.length) allUpdated.push(...result.updatedTrackPaths);
          if (result.removedTrackPaths?.length) allRemoved.push(...result.removedTrackPaths);
          if (result.cancelled) {
            return { filesAdded: totalAdded, filesProcessed: totalProcessed, cancelled: true, errors: allErrors };
          }
        }

        if (allAdded.length > 0 || allUpdated.length > 0 || allRemoved.length > 0) {
          lib
            .propagateScanToShadows(allAdded, allUpdated, allRemoved)
            .catch((err) => console.error("[ipc] Shadow propagation error:", err));
        }

        logActivity(
          getLibrary().getConnection(),
          "library_scan",
          `Scanned ${totalProcessed} files, ${totalAdded} added`
        );
        return { filesAdded: totalAdded, filesProcessed: totalProcessed, cancelled: false, errors: allErrors };
      } finally {
        activeScanAbort = null;
      }
    })
  );

  ipcMain.handle(
    "scan:cancel",
    safe(async () => {
      if (activeScanAbort) {
        activeScanAbort.abort();
        activeScanAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  ipcMain.handle(
    "library:getTracks",
    safe(async (_event, filter?: { contentType?: string; limit?: number; offset?: number }) => {
      return getLibrary().getTracks(filter as any);
    })
  );

  ipcMain.handle(
    "library:getStats",
    safe(async () => getLibrary().getStats())
  );

  ipcMain.handle(
    "activity:getRecent",
    safe(async () => getRecentActivity(getLibrary().getConnection()))
  );

  ipcMain.handle(
    "library:getFolders",
    safe(async () => getLibrary().getLibraryFolders())
  );

  ipcMain.handle(
    "library:addFolder",
    safe(async (_event, folder: { name: string; path: string; contentType: string }) => {
      const validated = validateFolderPath(folder.path);
      if ("error" in validated) return { error: validated.error };
      const result = getLibrary().addLibraryFolder(
        folder.name,
        validated.path,
        folder.contentType as any
      );
      logActivity(
        getLibrary().getConnection(),
        "add_folder",
        `Added folder: ${folder.name} (${validated.path})`
      );
      return result;
    })
  );

  ipcMain.handle(
    "library:removeFolder",
    safe(async (_event, folderId: number) => {
      const ok = getLibrary().removeLibraryFolder(folderId, true);
      if (!ok) throw new Error("Folder not found or could not remove");
    })
  );

  ipcMain.handle(
    "library:clearContentHashes",
    safe(async () => getLibrary().clearContentHashes())
  );

  // ---- Shadow Libraries -------------------------------------------------

  ipcMain.handle(
    "shadow:getAll",
    safe(async () => getLibrary().getShadowLibraries())
  );

  ipcMain.handle(
    "shadow:create",
    safe(async (
      event,
      config: { name: string; path: string; codecConfigId: number }
    ) => {
      const lib = getLibrary();
      const id = lib.createShadowLibrary(
        config.name,
        config.path,
        config.codecConfigId
      );

      activeShadowBuildAbort = new AbortController();
      lib
        .buildShadowLibrary(
          id,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("shadow:buildProgress", progress);
            }
          },
          activeShadowBuildAbort.signal
        )
        .catch((err) => {
          console.error("[ipc] Shadow build error:", err);
        })
        .finally(() => {
          activeShadowBuildAbort = null;
        });

      return lib.getShadowLibraryById(id);
    })
  );

  ipcMain.handle(
    "shadow:delete",
    safe(async (_event, shadowLibId: number, keepFilesOnDisk?: boolean) => {
      return getLibrary().deleteShadowLibrary(shadowLibId, !keepFilesOnDisk);
    })
  );

  ipcMain.handle(
    "shadow:rebuild",
    safe(async (event, shadowLibId: number) => {
      const lib = getLibrary();
      const shadowLib = lib.getShadowLibraryById(shadowLibId);
      if (!shadowLib) return { error: "Shadow library not found" };

      activeShadowBuildAbort = new AbortController();
      lib
        .buildShadowLibrary(
          shadowLibId,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("shadow:buildProgress", progress);
            }
          },
          activeShadowBuildAbort.signal
        )
        .catch((err) => {
          console.error("[ipc] Shadow rebuild error:", err);
        })
        .finally(() => {
          activeShadowBuildAbort = null;
        });

      return { started: true };
    })
  );

  ipcMain.handle(
    "shadow:cancelBuild",
    safe(async () => {
      if (activeShadowBuildAbort) {
        activeShadowBuildAbort.abort();
        activeShadowBuildAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  // ---- Devices ----------------------------------------------------------

  ipcMain.handle(
    "device:list",
    safe(async () => {
      return getDevicesCore().getDevices().map((d) => d.profile);
    })
  );

  ipcMain.handle(
    "device:add",
    safe(async (_event, config: AddDeviceConfig) => {
      const device = getDevicesCore().addDevice(config);
      logActivity(
        getLibrary().getConnection(),
        "add_device",
        `Added device: ${device.profile.name}`
      );
      return device.profile;
    })
  );

  ipcMain.handle(
    "device:getModels",
    safe(async () => {
      return getLibrary().getConnection()
        .prepare("SELECT id, name, internal_value, description FROM device_models ORDER BY id")
        .all();
    })
  );

  ipcMain.handle(
    "device:getCodecConfigs",
    safe(async () => {
      return getLibrary().getConnection().prepare(`
        SELECT cc.id, cc.name, cc.bitrate_value, cc.quality_value,
               cc.bits_per_sample, cc.is_default, c.name as codec_name
        FROM codec_configurations cc
        JOIN codecs c ON cc.codec_id = c.id
        ORDER BY c.name, cc.id
      `).all();
    })
  );

  ipcMain.handle(
    "device:setDefault",
    safe(async (_event, deviceId: number | null) => {
      return getDevicesCore().setDefaultDevice(deviceId);
    })
  );

  ipcMain.handle(
    "device:getDefault",
    safe(async () => {
      return getDevicesCore().getDefaultDeviceId();
    })
  );

  ipcMain.handle(
    "device:getSyncedPaths",
    safe(async (_event, deviceId: number) => {
      const rows = getLibrary().getConnection()
        .prepare("SELECT library_path FROM device_synced_tracks WHERE device_id = ?")
        .all(deviceId) as { library_path: string }[];
      return rows.map((r) => r.library_path);
    })
  );

  ipcMain.handle(
    "device:update",
    safe(async (_event, deviceId: number, updates: Record<string, unknown>) => {
      const ok = getDevicesCore().updateDevice(deviceId, updates);
      if (!ok) return { error: "Update failed" };
      const device = getDevicesCore().getDeviceById(deviceId)?.profile;
      logActivity(
        getLibrary().getConnection(),
        "update_device",
        `Updated device: ${device?.name ?? deviceId}`
      );
      return device;
    })
  );

  ipcMain.handle(
    "device:remove",
    safe(async (_event, deviceId: number) => {
      return getDevicesCore().deleteDevice(deviceId);
    })
  );

  ipcMain.handle(
    "device:check",
    safe(async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      const lib = getLibrary();
      if (!device.profile.skipPlaybackLog) {
        const ingest = readAndIngestPlaybackLog(
          deviceId,
          lib.getConnection(),
          device.mountPath,
          false,
          device.name
        );
        if (ingest.ingested > 0 || ingest.skipped > 0) {
          logActivity(
            lib.getConnection(),
            "read_playback_log",
            `${device.name} (check): ${ingest.ingested} ingested, ${ingest.skipped} skipped`
          );
        }
      }

      const musicStats = device.getContentStats("music");
      const podcastStats = device.getContentStats("podcast");
      const audiobookStats = device.getContentStats("audiobook");
      const playlistStats = device.getContentStats("playlist");
      const space = device.getAvailableSpace();

      const maps = buildLibraryTrackMaps(lib);
      let libraryMusicMap = maps.music;
      let libraryPodcastMap = maps.podcast;
      let libraryAudiobookMap = maps.audiobook;

      let codecName = device.profile.codecName ?? "copy";
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      if (
        device.profile.sourceLibraryType === "shadow" &&
        device.profile.shadowLibraryId != null
      ) {
        codecName = "DIRECT COPY";
        const shadowLib = lib.getShadowLibraryById(
          device.profile.shadowLibraryId
        );
        const shadowTrackMap = lib.getShadowTrackMap(
          device.profile.shadowLibraryId
        );

        const remapForCheck = (
          trackMap: Record<string, Record<string, unknown>>
        ): Record<string, Record<string, unknown>> => {
          const remapped: Record<string, Record<string, unknown>> = {};
          for (const [, info] of Object.entries(trackMap)) {
            const trackId = info.id as number;
            const shadowPath = shadowTrackMap.get(trackId);
            if (shadowPath) {
              remapped[shadowPath] = { ...info, path: shadowPath };
            }
          }
          return remapped;
        };

        libraryMusicMap = remapForCheck(libraryMusicMap);
        libraryPodcastMap = remapForCheck(libraryPodcastMap);
        libraryAudiobookMap = remapForCheck(libraryAudiobookMap);

        if (shadowLib) {
          for (const [folderId] of libraryFolderPaths) {
            libraryFolderPaths.set(folderId, shadowLib.path);
          }
        }
      }

      const deviceMusicRaw = device.getTracks("music");
      const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of deviceMusicRaw) {
        deviceMusicMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
      const devicePodcastRaw = device.getTracks("podcast");
      const devicePodcastMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of devicePodcastRaw) {
        devicePodcastMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
      const deviceAudiobookRaw = device.getTracks("audiobook");
      const deviceAudiobookMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of deviceAudiobookRaw) {
        deviceAudiobookMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }

      const profileCodecExt = getProfileCodecExt(codecName);

      const musicDest = buildLibraryDestMap(
        libraryMusicMap,
        "music",
        codecName,
        libraryFolderPaths
      );
      const musicCompare = compareLibraries(
        musicDest.destMap,
        musicDest.expectedSizes,
        device.getContentPath("music"),
        deviceMusicMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: musicDest.expectedMtimes,
        }
      );

      const podcastDest = buildLibraryDestMap(
        libraryPodcastMap,
        "podcast",
        codecName,
        libraryFolderPaths
      );
      const podcastCompare = compareLibraries(
        podcastDest.destMap,
        podcastDest.expectedSizes,
        device.getContentPath("podcast"),
        devicePodcastMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: podcastDest.expectedMtimes,
        }
      );

      const audiobookDest = buildLibraryDestMap(
        libraryAudiobookMap,
        "audiobook",
        codecName,
        libraryFolderPaths
      );
      const audiobookCompare = compareLibraries(
        audiobookDest.destMap,
        audiobookDest.expectedSizes,
        device.getContentPath("audiobook"),
        deviceAudiobookMap,
        {
          profileCodecExt,
          libraryExpectedMtimes: audiobookDest.expectedMtimes,
        }
      );

      const playlistFolder = device.getContentPath("playlist");
      let playlistOrphans: string[] = [];
      if (playlistFolder && fs.existsSync(playlistFolder)) {
        const core = getPlaylistCore();
        const libraryPlaylists = core.getPlaylists();
        const expectedStems = new Set(
          libraryPlaylists.map((pl) =>
            (pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist").toLowerCase()
          )
        );
        const walkPlaylists = (dir: string): void => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkPlaylists(fullPath);
            } else if (path.extname(entry.name).toLowerCase() === ".m3u") {
              const stem = path.parse(entry.name).name.toLowerCase();
              if (!expectedStems.has(stem)) {
                playlistOrphans.push(fullPath);
              }
            }
          }
        };
        walkPlaylists(playlistFolder);
      }

      const matchedLibraryPaths = [
        ...musicCompare.tracksToSkip.map((t) => t.library_path),
        ...podcastCompare.tracksToSkip.map((t) => t.library_path),
        ...audiobookCompare.tracksToSkip.map((t) => t.library_path),
      ];
      const conn = lib.getConnection();
      conn.prepare("DELETE FROM device_synced_tracks WHERE device_id = ?").run(deviceId);
      const insertStmt = conn.prepare(
        "INSERT OR REPLACE INTO device_synced_tracks (device_id, library_path) VALUES (?, ?)"
      );
      for (const lp of matchedLibraryPaths) {
        insertStmt.run(deviceId, lp);
      }

      const totalOnDevice = matchedLibraryPaths.length;
      getDevicesCore().updateDevice(deviceId, {
        totalSyncedItems: totalOnDevice,
      });

      return {
        deviceId,
        name: device.name,
        music: musicStats,
        podcasts: podcastStats,
        audiobooks: audiobookStats,
        playlists: playlistStats,
        disk: space,
        musicSyncedWithLibrary: musicCompare.tracksToSkip.length,
        musicOrphans: musicCompare.extras.length,
        podcastSyncedWithLibrary: podcastCompare.tracksToSkip.length,
        podcastOrphans: podcastCompare.extras.length,
        audiobookSyncedWithLibrary: audiobookCompare.tracksToSkip.length,
        audiobookOrphans: audiobookCompare.extras.length,
        playlistOrphans: playlistOrphans.length,
        orphansMusicPaths: musicCompare.extras,
        orphansPodcastPaths: podcastCompare.extras,
        orphansAudiobookPaths: audiobookCompare.extras,
        orphansPlaylistPaths: playlistOrphans,
      };
    })
  );

  ipcMain.handle(
    "device:readPlaybackLog",
    safe(async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      const lib = getLibrary();
      const ingest = readAndIngestPlaybackLog(
        deviceId,
        lib.getConnection(),
        device.mountPath,
        device.profile.skipPlaybackLog ?? false,
        device.name
      );
      logActivity(
        lib.getConnection(),
        "read_playback_log",
        `${device.name}: ${ingest.ingested} ingested, ${ingest.skipped} skipped`
      );
      const db = lib.getConnection();
      const summary = buildAnalysisSummaryFromDb(db);
      const artists = getArtistsFromPlaybackStats(db);
      return {
        ingested: ingest.ingested,
        skipped: ingest.skipped,
        summary,
        artists,
      };
    })
  );

  // ---- Sync -------------------------------------------------------------

  ipcMain.handle(
    "sync:start",
    safe(async (event, opts: SyncOptions) => {
      const lib = getLibrary();
      const dc = getDevicesCore();
      const device = dc.getDeviceById(opts.deviceId);
      if (!device) return { error: `Device ${opts.deviceId} not found` };

      activeSyncAbort = new AbortController();

      const { music: musicMap, podcast: podcastMap, audiobook: audiobookMap } =
        buildLibraryTrackMaps(lib);

      let musicLibraryTracks: Record<string, Record<string, unknown>> = {};
      let podcastLibraryTracks: Record<string, Record<string, unknown>> = {};
      let audiobookLibraryTracks: Record<string, Record<string, unknown>> = {};

      if (opts.syncType === "custom" && opts.selections) {
        const sel = opts.selections;
        const albumSet = new Set(sel.albums ?? []);
        const artistSet = new Set(sel.artists ?? []);
        const genreSet = new Set(sel.genres ?? []);
        const podcastSet = new Set(sel.podcasts ?? []);
        const audiobookSet = new Set(sel.audiobooks ?? []);

        const matchMusic = (t: Record<string, unknown>) => {
          const album = (String(t.album ?? "Unknown Album")).trim();
          const artist = (String(t.artist ?? "Unknown Artist")).trim();
          const genre = (String(t.genre ?? "Unknown Genre")).trim();
          const albumLabel = `${album} — ${artist}`;
          return albumSet.has(albumLabel) || artistSet.has(artist) || genreSet.has(genre);
        };
        const matchPodcast = (t: Record<string, unknown>) => {
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return podcastSet.has(label) || podcastSet.has(title);
        };
        const matchAudiobook = (t: Record<string, unknown>) => {
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return audiobookSet.has(label) || audiobookSet.has(title);
        };

        for (const [p, t] of Object.entries(musicMap)) {
          if (matchMusic(t)) musicLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(podcastMap)) {
          if (matchPodcast(t)) podcastLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(audiobookMap)) {
          if (matchAudiobook(t)) audiobookLibraryTracks[p] = t;
        }
      } else {
        const includeMusic = opts.syncType === "full" ? opts.includeMusic === true : true;
        const includePodcasts = opts.syncType === "full" ? opts.includePodcasts === true : true;
        const includeAudiobooks = opts.syncType === "full" ? opts.includeAudiobooks === true : true;
        if (includeMusic) musicLibraryTracks = { ...musicMap };
        if (includePodcasts) podcastLibraryTracks = { ...podcastMap };
        if (includeAudiobooks) audiobookLibraryTracks = { ...audiobookMap };
      }

      let codecName = device.profile.codecName ?? "copy";
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      if (
        device.profile.sourceLibraryType === "shadow" &&
        device.profile.shadowLibraryId != null
      ) {
        codecName = "DIRECT COPY";
        const shadowLib = lib.getShadowLibraryById(
          device.profile.shadowLibraryId
        );
        const shadowTrackMap = lib.getShadowTrackMap(
          device.profile.shadowLibraryId
        );

        const remapTracks = (
          trackMap: Record<string, Record<string, unknown>>
        ): Record<string, Record<string, unknown>> => {
          const remapped: Record<string, Record<string, unknown>> = {};
          for (const [origPath, info] of Object.entries(trackMap)) {
            const trackId = info.id as number;
            const shadowPath = shadowTrackMap.get(trackId);
            if (shadowPath) {
              remapped[shadowPath] = { ...info, path: shadowPath };
            }
          }
          return remapped;
        };

        musicLibraryTracks = remapTracks(musicLibraryTracks);
        podcastLibraryTracks = remapTracks(podcastLibraryTracks);
        audiobookLibraryTracks = remapTracks(audiobookLibraryTracks);

        if (shadowLib) {
          for (const [folderId] of libraryFolderPaths) {
            libraryFolderPaths.set(folderId, shadowLib.path);
          }
        }
      }

      const syncOpts: RunSyncOptions = {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        cancelSignal: activeSyncAbort.signal,
        ignoreSpaceCheck: opts.ignoreSpaceCheck,
        progressCallback: (progressEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("sync:progress", progressEvent);
          }
        },
      };

      let result: {
        status: string;
        synced: number;
        removed: number;
        extras: string[];
        missingFiles: string[];
        errors: number;
      } = { status: "completed", synced: 0, removed: 0, extras: [], missingFiles: [], errors: 0 };

      const willRunMusic = Object.keys(musicLibraryTracks).length > 0;
      const willRunPodcast = Object.keys(podcastLibraryTracks).length > 0;
      const willRunAudiobook = Object.keys(audiobookLibraryTracks).length > 0;
      const isEmptyLibrary = !willRunMusic && !willRunPodcast && !willRunAudiobook;

      if (isEmptyLibrary) {
        const isShadow = device.profile.sourceLibraryType === "shadow" && device.profile.shadowLibraryId != null;
        const emptyMessage = isShadow
          ? "Shadow library contains no files to sync. Build or select a shadow library that has tracks."
          : "Library contains no music, podcast, or audiobook files to sync. Add library folders and scan first.";
        syncOpts.progressCallback?.({ event: "log", message: emptyMessage });
        syncOpts.progressCallback?.({ event: "total", path: "0" });
        activeSyncAbort = null;
        return { error: emptyMessage };
      }

      const deviceMusicPath = device.getContentPath("music");
      try {
        fs.mkdirSync(deviceMusicPath, { recursive: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES") {
          activeSyncAbort = null;
          return {
            error:
              `Permission denied writing to device (${deviceMusicPath}). ` +
              "Ensure the device is mounted with write access and you have permission to create folders. " +
              "On Linux, try ejecting and reconnecting the device, or check mount permissions.",
          };
        }
        throw err;
      }

      if (!device.profile.skipPlaybackLog) {
        syncOpts.progressCallback?.({ event: "log", message: "Reading playback.log..." });
        const ingest = readAndIngestPlaybackLog(
          opts.deviceId,
          lib.getConnection(),
          device.mountPath,
          false,
          device.name
        );
        if (ingest.ingested > 0 || ingest.skipped > 0) {
          syncOpts.progressCallback?.({
            event: "log",
            message: `Ingested ${ingest.ingested} playback events (${ingest.skipped} duplicates skipped).`,
          });
        }
      }

      if (willRunMusic) {
        const deviceMusicRaw = device.getTracks("music", { cancelSignal: activeSyncAbort.signal });
        const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of deviceMusicRaw) {
          deviceMusicMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const musicResult = await runSync(
          device,
          musicLibraryTracks,
          codecName,
          "music",
          deviceMusicPath,
          deviceMusicMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += musicResult.synced;
        result.removed += musicResult.removed;
        result.errors += musicResult.errors;
        result.extras = [...result.extras, ...musicResult.extras];
        result.missingFiles = [...result.missingFiles, ...musicResult.missingFiles];
      }

      if (willRunPodcast) {
        const devicePodcastPath = device.getContentPath("podcast");
        const devicePodcastRaw = device.getTracks("podcast", { cancelSignal: activeSyncAbort.signal });
        const devicePodcastMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of devicePodcastRaw) {
          devicePodcastMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const podcastResult = await runSync(
          device,
          podcastLibraryTracks,
          codecName,
          "podcast",
          devicePodcastPath,
          devicePodcastMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += podcastResult.synced;
        result.removed += podcastResult.removed;
        result.errors += podcastResult.errors;
        result.extras = [...result.extras, ...podcastResult.extras];
        result.missingFiles = [...result.missingFiles, ...podcastResult.missingFiles];
      }

      if (willRunAudiobook) {
        const deviceAudiobookPath = device.getContentPath("audiobook");
        const deviceAudiobookRaw = device.getTracks("audiobook", { cancelSignal: activeSyncAbort.signal });
        const deviceAudiobookMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of deviceAudiobookRaw) {
          deviceAudiobookMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const audiobookResult = await runSync(
          device,
          audiobookLibraryTracks,
          codecName,
          "audiobook",
          deviceAudiobookPath,
          deviceAudiobookMap,
          syncOpts,
          libraryFolderPaths
        );
        result.synced += audiobookResult.synced;
        result.removed += audiobookResult.removed;
        result.errors += audiobookResult.errors;
        result.extras = [...result.extras, ...audiobookResult.extras];
        result.missingFiles = [...result.missingFiles, ...audiobookResult.missingFiles];
      }

      if (result.errors > 0) result.status = "error";

      const shouldWritePlaylists =
        result.errors === 0 &&
        (opts.syncType === "custom"
          ? (opts.selections?.playlists?.length ?? 0) > 0
          : opts.includePlaylists !== false);

      let playlistsWritten = 0;
      if (shouldWritePlaylists) {
        const playlistFolder = device.getContentPath("playlist");
        if (playlistFolder) {
          try {
            const core = getPlaylistCore();
            let playlistsToWrite = core.getPlaylists();
            if (opts.syncType === "custom" && opts.selections?.playlists?.length) {
              const selectedSet = new Set(opts.selections.playlists);
              playlistsToWrite = playlistsToWrite.filter((pl) => selectedSet.has(pl.name));
            }
            const musicFolder = device.profile.musicFolder ?? "Music";
            const m3uOpts = {
              musicFolder,
              codecName,
              libraryFolderPaths,
            };
            if (!fs.existsSync(playlistFolder)) {
              fs.mkdirSync(playlistFolder, { recursive: true });
            }
            const normalizeM3uForCompare = (s: string) =>
              s.replace(/# Generated: .+/g, "# Generated: <date>");
            syncOpts.progressCallback?.({
              event: "total_add",
              path: String(playlistsToWrite.length),
            });
            for (const pl of playlistsToWrite) {
              const content = core.buildM3uContentForDevice(pl.id, m3uOpts);
              const safeName = pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist";
              const outPath = path.join(playlistFolder, `${safeName}.m3u`);
              const existingRaw = fs.existsSync(outPath)
                ? (fs.readFileSync(outPath, "utf-8") as string)
                : null;
              const needsWrite =
                existingRaw === null ||
                normalizeM3uForCompare(existingRaw) !== normalizeM3uForCompare(content);
              if (needsWrite) {
                fs.writeFileSync(outPath, content, "utf-8");
                playlistsWritten += 1;
              }
              syncOpts.progressCallback?.({
                event: "copy",
                path: outPath,
                status: needsWrite ? "copied" : "skipped",
                contentType: "playlist",
              });
            }
            if (playlistsWritten > 0) {
              syncOpts.progressCallback?.({
                event: "log",
                message: `Written ${playlistsWritten} playlist(s) to device.`,
              });
            } else if (playlistsToWrite.length > 0) {
              syncOpts.progressCallback?.({
                event: "log",
                message: "Playlist(s) already up to date.",
              });
            }
          } catch (err) {
            console.error("[ipc] Sync playlists to device failed:", err);
          }
        }
      }

      // Always detect and optionally remove playlist orphans when device has playlist folder
      // (runs even when not syncing playlists, e.g. includePlaylists=false or custom with none)
      const playlistFolder = device.getContentPath("playlist");
      if (playlistFolder && fs.existsSync(playlistFolder)) {
        try {
          const core = getPlaylistCore();
          const libraryPlaylists = core.getPlaylists();
          const expectedStems = new Set(
            libraryPlaylists.map((pl) =>
              (pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist").toLowerCase()
            )
          );
          const orphanPaths: string[] = [];
          const walkPlaylists = (dir: string): void => {
            let entries: fs.Dirent[];
            try {
              entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkPlaylists(fullPath);
              } else if (path.extname(entry.name).toLowerCase() === ".m3u") {
                const stem = path.parse(entry.name).name.toLowerCase();
                if (!expectedStems.has(stem)) {
                  orphanPaths.push(fullPath);
                }
              }
            }
          };
          walkPlaylists(playlistFolder);
          if (orphanPaths.length > 0) {
            result.extras = [...result.extras, ...orphanPaths];
            syncOpts.progressCallback?.({
              event: "log",
              message: `${orphanPaths.length} orphan playlist(s) on device.`,
            });
            if (opts.extraTrackPolicy === "remove") {
              const { removed } = removeExtraTracks(
                orphanPaths,
                syncOpts.progressCallback,
                activeSyncAbort?.signal
              );
              result.removed += removed;
              syncOpts.progressCallback?.({
                event: "log",
                message: `Removed ${removed} orphan playlist(s) from device.`,
              });
            }
          }
        } catch (err) {
          console.error("[ipc] Playlist orphan detection failed:", err);
        }
      }

      result.synced += playlistsWritten;
      activeSyncAbort = null;

      if (result.synced >= 0) {
        try {
          const device = getDevicesCore().getDeviceById(opts.deviceId);
          const prevTotal = device?.profile?.totalSyncedItems ?? 0;
          const newTotal = Math.max(0, prevTotal + result.synced - result.removed);
          getDevicesCore().updateDevice(opts.deviceId, {
            lastSyncDate: new Date().toISOString(),
            lastSyncCount: result.synced,
            totalSyncedItems: newTotal,
          });
          logActivity(
            getLibrary().getConnection(),
            "sync",
            `${device?.name ?? "Device"}: ${result.synced} synced, ${result.removed} removed`
          );
        } catch (e) {
          console.error("[ipc] Update device last sync failed:", e);
        }
      }

      if (result.removed > 0) {
        syncOpts.progressCallback?.({
          event: "log",
          message: `Sync complete. ${result.removed} file(s) removed from device.`,
        });
      }
      syncOpts.progressCallback?.({ event: "complete", path: "", status: "complete" });

      return result;
    })
  );

  ipcMain.handle(
    "sync:cancel",
    safe(async () => {
      if (activeSyncAbort) {
        activeSyncAbort.abort();
        activeSyncAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  // ---- Playlists ---------------------------------------------------------

  ipcMain.handle(
    "playlist:list",
    safe(async (_event, playlistType?: string) => {
      return getPlaylistCore().getPlaylists(playlistType);
    })
  );

  ipcMain.handle(
    "playlist:getTracks",
    safe(async (_event, playlistId: number) => {
      return getPlaylistCore().getPlaylistTracks(playlistId);
    })
  );

  ipcMain.handle(
    "playlist:create",
    safe(async (_event, config: {
      name: string;
      strategy: string;
      trackLimit?: number;
      rules?: SmartPlaylistRule[];
    }) => {
      const core = getPlaylistCore();
      const rules = config.rules ?? [];
      if (rules.length === 0) {
        throw new Error("Smart playlist requires at least one rule (genre, artist, or album).");
      }
      const id = core.createSmartPlaylist(
        config.name,
        rules,
        "",
        config.trackLimit
      );
      const p = core.getPlaylistById(id);
      if (!p) throw new Error("Playlist not found after create");
      return p;
    })
  );

  ipcMain.handle(
    "playlist:delete",
    safe(async (_event, playlistId: number) => {
      getPlaylistCore().deletePlaylist(playlistId);
    })
  );

  ipcMain.handle(
    "playlist:export",
    safe(async (_event, playlistId: number, deviceId?: number) => {
      const core = getPlaylistCore();
      const defaultName = core.getPlaylistById(playlistId)?.name ?? "playlist";
      const { filePath } = await dialog.showSaveDialog({
        title: "Export playlist",
        defaultPath: `${defaultName}.m3u`,
        filters: [{ name: "M3U", extensions: ["m3u"] }],
      });
      if (!filePath) throw new Error("Save cancelled");

      const lib = getLibrary();
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      let musicFolder = "Music";
      let codecName = "COPY";
      if (deviceId != null) {
        const dc = getDevicesCore();
        const device = dc.getDeviceById(deviceId);
        if (device?.profile) {
          musicFolder = device.profile.musicFolder ?? "Music";
          codecName = device.profile.codecName ?? "COPY";
        }
      }

      return core.exportPlaylistM3u(playlistId, filePath, {
        musicFolder,
        codecName,
        libraryFolderPaths,
      });
    })
  );

  ipcMain.handle(
    "playlist:getGenres",
    safe(async () => getPlaylistCore().getGenres())
  );

  ipcMain.handle(
    "playlist:getArtists",
    safe(async () => getPlaylistCore().getArtists())
  );

  ipcMain.handle(
    "playlist:getAlbums",
    safe(async () => getPlaylistCore().getAlbums())
  );

  // ---- Savant Playlists -------------------------------------------------

  ipcMain.handle(
    "savant:generate",
    safe(async (_event, intent: import("../shared/types").SavantIntent) => {
      const config = getOpenRouterConfig();
      if (!config) return { error: "OpenRouter API key not configured. Add it in Settings." };
      const db = getLibrary().getConnection();
      const core = getPlaylistCore();
      const result = await generateSavantPlaylist(
        intent,
        config,
        db,
        (name, trackIds, savantConfig) =>
          core.createSavantPlaylist(name, trackIds, savantConfig)
      );
      if (result && !("error" in result)) {
        logActivity(
          db,
          "playlist_generated",
          `Savant: ${result.name} (${result.trackCount} tracks)`
        );
      }
      return result;
    })
  );

  ipcMain.handle(
    "savant:checkKeyData",
    safe(async () => {
      const db = getLibrary().getConnection();
      const keyed = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND camelot IS NOT NULL"
        )
        .get() as { c: number };
      const total = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'"
        )
        .get() as { c: number };
      const coveragePct =
        total.c > 0 ? Math.round((keyed.c / total.c) * 100) : 0;
      return {
        keyedCount: keyed.c,
        totalCount: total.c,
        coveragePct,
      };
    })
  );

  ipcMain.handle(
    "savant:backfillFeatures",
    safe(async (event, opts?: { percent?: number }) => {
      activeBackfillAbort = new AbortController();
      const signal = activeBackfillAbort.signal;

      const lib = getLibrary();
      const db = lib.getConnection();
      const scanner = new LibraryScanner(db);
      const harmonic = getHarmonicPrefs();

      const sendProgress = (p: import("../shared/types").BackfillProgress) => {
        event.sender.send("savant:backfillProgress", p);
      };

      try {
        if (harmonic.analyzeWithEssentia) {
          const percent = Math.min(
            100,
            Math.max(1, opts?.percent ?? harmonic.analyzePercent ?? 10)
          );
          const processed = await scanner.backfillFeaturesWithEssentia(
            percent,
            sendProgress,
            signal
          );
          const cancelled = signal.aborted;
          return { processed, cancelled };
        }

        const percent = Math.min(
          100,
          Math.max(1, opts?.percent ?? harmonic.backfillPercent ?? 100)
        );
        const totalMusic = (
          db.prepare(
            "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'"
          ).get() as { c: number }
        ).c;
        const maxTracks = Math.max(50, Math.ceil((totalMusic * percent) / 100));
        const processed = await scanner.backfillFeatures(
          maxTracks,
          sendProgress,
          signal
        );
        const cancelled = signal.aborted;
        return { processed, cancelled };
      } finally {
        activeBackfillAbort = null;
      }
    })
  );

  ipcMain.handle(
    "savant:backfillCancel",
    safe(async () => {
      if (activeBackfillAbort) {
        activeBackfillAbort.abort();
        activeBackfillAbort = null;
      }
    })
  );

  ipcMain.handle(
    "savant:chat:start",
    safe(async () => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const sessionId = randomUUID();
      const db = getLibrary().getConnection();
      const { state, aiMessage } = await startMoodChat(config, db);
      cleanupChatSessions(moodChatSessions);
      moodChatSessions.set(sessionId, { state, createdAt: Date.now() });
      return { sessionId, aiMessage };
    })
  );

  ipcMain.handle(
    "savant:chat:turn",
    safe(async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const entry = moodChatSessions.get(sessionId);
      if (!entry) return { error: "Chat session not found" };
      const db = getLibrary().getConnection();
      const result = await processMoodChatTurn(
        entry.state,
        userMessage,
        config,
        db
      );
      if (result.isComplete) moodChatSessions.delete(sessionId);
      return result;
    })
  );

  ipcMain.handle(
    "savant:chat:skip",
    safe(async (_event, sessionId: string) => {
      moodChatSessions.delete(sessionId);
    })
  );

  ipcMain.handle(
    "savant:playlistChat:start",
    safe(async () => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const sessionId = randomUUID();
      const db = getLibrary().getConnection();
      const { state, aiMessage } = await startSavantPlaylistChat(config, db);
      cleanupChatSessions(savantPlaylistChatSessions);
      savantPlaylistChatSessions.set(sessionId, { state, createdAt: Date.now() });
      return { sessionId, aiMessage };
    })
  );

  ipcMain.handle(
    "savant:playlistChat:turn",
    safe(async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const entry = savantPlaylistChatSessions.get(sessionId);
      if (!entry) return { error: "Chat session not found" };
      const db = getLibrary().getConnection();
      const result = await processSavantPlaylistChatTurn(
        entry.state,
        userMessage,
        config,
        db
      );
      if (result.isComplete) savantPlaylistChatSessions.delete(sessionId);
      return result;
    })
  );

  ipcMain.handle(
    "savant:playlistChat:skip",
    safe(async (_event, sessionId: string) => {
      savantPlaylistChatSessions.delete(sessionId);
    })
  );

  ipcMain.handle(
    "assistant:chat",
    safe(async (_event, userMessage: string) => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const db = getLibrary().getConnection();
      const recentHistory = loadNonPinnedHistory(db);
      const fullHistory = [
        ...recentHistory,
        { role: "user" as const, content: userMessage },
      ];
      const rawReply = await sendAssistantMessage(fullHistory, db, config);
      const {
        cleanReply,
        pin,
        unpinIds,
        replaceId,
        smartPlaylist,
        geniusPlaylist,
      } = parseActionTags(rawReply);

      let playlistCreated: string | undefined;

      try {
        if (smartPlaylist) {
          const core = getPlaylistCore();
          core.createSmartPlaylist(
            smartPlaylist.name,
            smartPlaylist.rules,
            "",
            smartPlaylist.trackLimit
          );
          logActivity(db, "playlist_generated", `Smart: ${smartPlaylist.name}`);
          playlistCreated = smartPlaylist.name;
        } else if (geniusPlaylist) {
          const result = generateGeniusPlaylistFromDb(
            geniusPlaylist.geniusType,
            db,
            geniusPlaylist.opts
          );
          const trackIds = result.tracks.map((t) => t.id);
          const maxTracks = geniusPlaylist.opts.maxTracks ?? 25;
          if (trackIds.length > 0) {
            const core = getPlaylistCore();
            core.createGeniusPlaylist(
              geniusPlaylist.geniusType,
              trackIds,
              null,
              maxTracks,
              geniusPlaylist.name
            );
            logActivity(
              db,
              "playlist_generated",
              `Genius: ${geniusPlaylist.name} (${trackIds.length} tracks)`
            );
            playlistCreated = geniusPlaylist.name;
          }
        }
      } catch (err) {
        console.error("[assistant] playlist creation failed:", err);
      }

      const { userMsgId, assistantMsgId } = saveAssistantMessages(
        db,
        userMessage,
        cleanReply
      );

      for (const uid of unpinIds) unpinMessages(db, uid);
      if (replaceId) unpinMessages(db, replaceId);

      if (pin || replaceId) {
        if (replaceId || getPinnedCount(db) < MAX_PINNED_MEMORIES) {
          pinMessages(db, userMsgId, assistantMsgId);
        }
      }

      return { reply: cleanReply, playlistCreated };
    })
  );

  ipcMain.handle(
    "assistant:history:load",
    safe(async () => {
      const db = getLibrary().getConnection();
      return loadAssistantHistory(db);
    })
  );

  ipcMain.handle(
    "assistant:history:clear",
    safe(async () => {
      const db = getLibrary().getConnection();
      clearAssistantHistory(db);
    })
  );

  // ---- Settings (OpenRouter) ---------------------------------------------

  ipcMain.handle(
    "settings:getOpenRouterConfig",
    safe(async () => getOpenRouterConfig())
  );

  ipcMain.handle(
    "settings:setOpenRouterConfig",
    safe(async (_event, config: import("../shared/types").OpenRouterConfig | null) => {
      setOpenRouterConfig(config);
    })
  );

  ipcMain.handle(
    "settings:testOpenRouter",
    safe(async (_event, configOverride?: { apiKey: string; model: string } | null) => {
      const config = configOverride ?? getOpenRouterConfig();
      if (!config?.apiKey?.trim()) return { ok: false, error: "No API key" };
      const { callOpenRouter } = await import("./llm/openRouterClient");
      await callOpenRouter(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { apiKey: config.apiKey, model: config.model?.trim() || "anthropic/claude-sonnet-4.6" },
        false
      );
      return { ok: true };
    })
  );

  // ---- Harmonic / Library scan -------------------------------------------

  ipcMain.handle(
    "settings:getHarmonicPrefs",
    safe(async () => getHarmonicPrefs())
  );

  ipcMain.handle(
    "settings:setHarmonicPrefs",
    safe(async (_event, prefs: HarmonicPrefs) => {
      setHarmonicPrefs(prefs);
    })
  );
}
