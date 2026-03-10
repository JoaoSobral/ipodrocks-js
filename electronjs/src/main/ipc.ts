import * as fs from "fs";
import * as path from "path";
import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from "electron";

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
import {
  buildAnalysisSummary,
  generateGeniusPlaylist,
  getArtistsFromEvents,
  getAvailableGeniusTypes,
  matchEventsToLibrary,
} from "./playlists/genius-engine";
import {
  runSync,
  RunSyncOptions,
  buildLibraryDestMap,
  getProfileCodecExt,
} from "./sync/sync-core";
import { compareLibraries } from "./sync/name-size-sync";
import { isMpcencAvailable } from "./utils/mpcenc";
import {
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  getOpenRouterConfig,
  setOpenRouterConfig,
} from "./utils/prefs";
import { generateSavantPlaylist } from "./savant/savantEngine";
import {
  startMoodChat,
  processMoodChatTurn,
  type MoodChatState,
} from "./savant/moodChat";
import { sendAssistantMessage } from "./assistant/assistantChat";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let library: Library | null = null;
let devicesCore: DevicesCore | null = null;
let playlistCore: PlaylistCore | null = null;
let activeSyncAbort: AbortController | null = null;
let activeScanAbort: AbortController | null = null;
let activeShadowBuildAbort: AbortController | null = null;

/** In-memory cache of matched playback events keyed by device ID. */
const geniusEventsCache = new Map<number, MatchedPlayEvent[]>();

/** Ephemeral mood chat sessions keyed by session ID. */
const moodChatSessions = new Map<string, MoodChatState>();

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
    "genius:types",
    safe(async () => getAvailableGeniusTypes())
  );

  ipcMain.handle(
    "genius:generate",
    safe(async (
      _event,
      deviceId: number,
      geniusType: string,
      opts: GeniusGenerateOptions
    ) => {
      const cached = geniusEventsCache.get(deviceId);
      if (!cached) {
        return {
          error: "No analysis data. Run Analyze Device first.",
        };
      }
      const db = getLibrary().getConnection();
      return generateGeniusPlaylist(geniusType, cached, db, opts);
    })
  );

  ipcMain.handle(
    "genius:save",
    safe(async (
      _event,
      name: string,
      geniusType: string,
      deviceId: number,
      trackIds: number[],
      trackLimit: number
    ) => {
      const core = getPlaylistCore();
      const id = core.createGeniusPlaylist(
        geniusType,
        trackIds,
        deviceId,
        trackLimit,
        name
      );
      return core.getPlaylistById(id);
    })
  );

  // ---- Dialog -----------------------------------------------------------

  ipcMain.handle(
    "dialog:pickFolder",
    safe(async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win!, {
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

      let totalAdded = 0;
      let totalProcessed = 0;

      const allErrors: string[] = [];
      const allAdded: string[] = [];
      const allUpdated: string[] = [];
      const allRemoved: string[] = [];
      try {
        for (const folder of payload.folders) {
          const result = await scanner.scanFolder(
            folder.path,
            folder.contentType,
            (progress) => event.sender.send("scan:progress", progress),
            activeScanAbort.signal
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
    "library:getFolders",
    safe(async () => getLibrary().getLibraryFolders())
  );

  ipcMain.handle(
    "library:addFolder",
    safe(async (_event, folder: { name: string; path: string; contentType: string }) => {
      return getLibrary().addLibraryFolder(folder.name, folder.path, folder.contentType as any);
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
      return getDevicesCore().getDeviceById(deviceId)?.profile;
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
      const musicStats = device.getContentStats("music");
      const podcastStats = device.getContentStats("podcast");
      const audiobookStats = device.getContentStats("audiobook");
      const playlistStats = device.getContentStats("playlist");
      const space = device.getAvailableSpace();

      const musicTracks = lib.getTracks({ contentType: "music" as any });
      const podcastTracks = lib.getTracks({ contentType: "podcast" as any });
      const audiobookTracks = lib.getTracks({ contentType: "audiobook" as any });
      let libraryMusicMap: Record<string, Record<string, unknown>> = {};
      for (const t of musicTracks) {
        libraryMusicMap[t.path] = t as unknown as Record<string, unknown>;
      }
      let libraryPodcastMap: Record<string, Record<string, unknown>> = {};
      for (const t of podcastTracks) {
        libraryPodcastMap[t.path] = t as unknown as Record<string, unknown>;
      }
      let libraryAudiobookMap: Record<string, Record<string, unknown>> = {};
      for (const t of audiobookTracks) {
        libraryAudiobookMap[t.path] = t as unknown as Record<string, unknown>;
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
        orphansMusicPaths: musicCompare.extras,
        orphansPodcastPaths: podcastCompare.extras,
        orphansAudiobookPaths: audiobookCompare.extras,
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

      const musicTracks = lib.getTracks({ contentType: "music" as any });
      const podcastTracks = lib.getTracks({ contentType: "podcast" as any });
      const audiobookTracks = lib.getTracks({ contentType: "audiobook" as any });

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

        const matchMusic = (t: { path: string; album?: string; artist?: string; genre?: string }) => {
          const album = (t.album ?? "Unknown Album").trim();
          const artist = (t.artist ?? "Unknown Artist").trim();
          const genre = (t.genre ?? "Unknown Genre").trim();
          const albumLabel = `${album} — ${artist}`;
          return albumSet.has(albumLabel) || artistSet.has(artist) || genreSet.has(genre);
        };
        const matchPodcast = (t: { title?: string; filename?: string; artist?: string }) => {
          const title = (t.title ?? t.filename ?? "Untitled").trim();
          const artist = (t.artist ?? "").trim();
          const label = artist ? `${title} — ${artist}` : title;
          return podcastSet.has(label) || podcastSet.has(title);
        };
        const matchAudiobook = (t: { title?: string; filename?: string; artist?: string }) => {
          const title = (t.title ?? t.filename ?? "Untitled").trim();
          const artist = (t.artist ?? "").trim();
          const label = artist ? `${title} — ${artist}` : title;
          return audiobookSet.has(label) || audiobookSet.has(title);
        };

        for (const t of musicTracks) {
          if (matchMusic(t)) {
            musicLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
        for (const t of podcastTracks) {
          if (matchPodcast(t)) {
            podcastLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
        for (const t of audiobookTracks) {
          if (matchAudiobook(t)) {
            audiobookLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
      } else {
        const includeMusic = opts.syncType === "full" ? opts.includeMusic === true : true;
        const includePodcasts = opts.syncType === "full" ? opts.includePodcasts === true : true;
        const includeAudiobooks = opts.syncType === "full" ? opts.includeAudiobooks === true : true;
        if (includeMusic) {
          for (const t of musicTracks) {
            musicLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
        if (includePodcasts) {
          for (const t of podcastTracks) {
            podcastLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
        if (includeAudiobooks) {
          for (const t of audiobookTracks) {
            audiobookLibraryTracks[t.path] = t as unknown as Record<string, unknown>;
          }
        }
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

      if (willRunMusic) {
        const deviceMusicPath = device.getContentPath("music");
        const deviceMusicRaw = device.getTracks("music", { cancelSignal: activeSyncAbort.signal });
        const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
        for (const [p, info] of deviceMusicRaw) {
          deviceMusicMap[p] = {
            file_size: info.fileSize,
            ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
          };
        }
        const musicResult = await runSync(
          device.profile,
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
          device.profile,
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
          device.profile,
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
      activeSyncAbort = null;

      const shouldWritePlaylists =
        result.errors === 0 &&
        (opts.syncType === "custom"
          ? (opts.selections?.playlists?.length ?? 0) > 0
          : opts.includePlaylists !== false);

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
            let playlistsWritten = 0;
            for (const pl of playlistsToWrite) {
              const content = core.buildM3uContentForDevice(pl.id, m3uOpts);
              const safeName = pl.name.replace(/[/\\?*:"<>|]/g, "_").trim() || "Playlist";
              const outPath = path.join(playlistFolder, `${safeName}.m3u`);
              const existingRaw = fs.existsSync(outPath)
                ? (fs.readFileSync(outPath, "utf-8") as string)
                : null;
              if (existingRaw === null || normalizeM3uForCompare(existingRaw) !== normalizeM3uForCompare(content)) {
                fs.writeFileSync(outPath, content, "utf-8");
                playlistsWritten += 1;
              }
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

      if (result.synced >= 0) {
        try {
          getDevicesCore().updateDevice(opts.deviceId, {
            lastSyncDate: new Date().toISOString(),
            totalSyncedItems: result.synced,
          });
        } catch (e) {
          console.error("[ipc] Update device last sync failed:", e);
        }
      }

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
      return generateSavantPlaylist(
        intent,
        config,
        db,
        (name, trackIds, savantConfig) =>
          core.createSavantPlaylist(name, trackIds, savantConfig)
      );
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
    safe(async () => {
      const scanner = new LibraryScanner(getLibrary().getConnection());
      const processed = await scanner.backfillFeatures(50);
      return { processed };
    })
  );

  ipcMain.handle(
    "savant:chat:start",
    safe(async () => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const sessionId = randomUUID();
      const { state, aiMessage } = await startMoodChat(config);
      moodChatSessions.set(sessionId, state);
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
      const state = moodChatSessions.get(sessionId);
      if (!state) return { error: "Chat session not found" };
      const result = await processMoodChatTurn(state, userMessage, config);
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
    "assistant:chat",
    safe(async (
      _event,
      messages: Array<{ role: "user" | "assistant"; content: string }>
    ) => {
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const db = getLibrary().getConnection();
      const reply = await sendAssistantMessage(messages, db, config);
      return { reply };
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
}
