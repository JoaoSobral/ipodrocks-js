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

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let library: Library | null = null;
let devicesCore: DevicesCore | null = null;
let playlistCore: PlaylistCore | null = null;
let activeSyncAbort: AbortController | null = null;
let activeScanAbort: AbortController | null = null;

/** In-memory cache of matched playback events keyed by device ID. */
const geniusEventsCache = new Map<number, MatchedPlayEvent[]>();

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
  getLibrary();
  return devicesCore!;
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

// ---------------------------------------------------------------------------
// Dev mode (--dev flag): enables orphan/sync diagnostics and debug:log
// ---------------------------------------------------------------------------

const isDevMode = process.argv.includes("--dev");

const DEBUG_LOG_PATH = "/home/pedro/Documents/GitHub/ipodrocks/.cursor/debug-466793.log";

function appendDebugLog(payload: Record<string, unknown>): void {
  if (!isDevMode) return;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, JSON.stringify({ ...payload, timestamp: Date.now() }) + "\n");
  } catch {
    // ignore
  }
}

function syncDebugLog(
  message: string,
  data: Record<string, unknown>,
  hypothesisId?: string
): void {
  try {
    const line =
      JSON.stringify({
        sessionId: "466793",
        location: "ipc.ts:sync:start",
        message,
        data,
        hypothesisId,
        timestamp: Date.now(),
      }) + "\n";
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // ignore
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("debug:log", (_event, payload: { message?: string; data?: Record<string, unknown> }) => {
    if (isDevMode) {
      appendDebugLog({ location: "renderer", message: payload.message ?? "", data: payload.data ?? {} });
    }
    return undefined;
  });

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
          if (result.cancelled) {
            return { filesAdded: totalAdded, filesProcessed: totalProcessed, cancelled: true, errors: allErrors };
          }
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
      const playlistStats = device.getContentStats("playlist");
      const space = device.getAvailableSpace();

      const musicTracks = lib.getTracks({ contentType: "music" as any });
      const podcastTracks = lib.getTracks({ contentType: "podcast" as any });
      const libraryMusicMap: Record<string, Record<string, unknown>> = {};
      for (const t of musicTracks) {
        libraryMusicMap[t.path] = t as unknown as Record<string, unknown>;
      }
      const libraryPodcastMap: Record<string, Record<string, unknown>> = {};
      for (const t of podcastTracks) {
        libraryPodcastMap[t.path] = t as unknown as Record<string, unknown>;
      }

      const codecName = device.profile.codecName ?? "copy";
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
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
          ...(isDevMode && {
            debugCallback: (msg: string) => {
              if (msg.startsWith("[ORPHAN-DIAG]")) console.log(msg);
            },
          }),
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
          ...(isDevMode && {
            debugCallback: (msg: string) => {
              if (msg.startsWith("[ORPHAN-DIAG]")) console.log(msg);
            },
          }),
        }
      );

      const matchedLibraryPaths = [
        ...musicCompare.tracksToSkip.map((t) => t.library_path),
        ...podcastCompare.tracksToSkip.map((t) => t.library_path),
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
        playlists: playlistStats,
        disk: space,
        musicSyncedWithLibrary: musicCompare.tracksToSkip.length,
        musicOrphans: musicCompare.extras.length,
        podcastSyncedWithLibrary: podcastCompare.tracksToSkip.length,
        podcastOrphans: podcastCompare.extras.length,
        orphansMusicPaths: musicCompare.extras,
        orphansPodcastPaths: podcastCompare.extras,
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

      let musicLibraryTracks: Record<string, Record<string, unknown>> = {};
      let podcastLibraryTracks: Record<string, Record<string, unknown>> = {};

      if (opts.syncType === "custom" && opts.selections) {
        const sel = opts.selections;
        const albumSet = new Set(sel.albums ?? []);
        const artistSet = new Set(sel.artists ?? []);
        const genreSet = new Set(sel.genres ?? []);
        const podcastSet = new Set(sel.podcasts ?? []);

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
      } else {
        const includeMusic = opts.syncType === "full" ? opts.includeMusic === true : true;
        const includePodcasts = opts.syncType === "full" ? opts.includePodcasts === true : true;
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
      }

      // #region agent log
      syncDebugLog("sync build maps", {
        syncType: opts.syncType,
        includeMusic: opts.includeMusic,
        includePodcasts: opts.includePodcasts,
        includePlaylists: opts.includePlaylists,
        musicCount: Object.keys(musicLibraryTracks).length,
        podcastCount: Object.keys(podcastLibraryTracks).length,
      }, "H1");
      // #endregion

      const codecName = device.profile.codecName ?? "copy";
      const folders = lib.getLibraryFolders();
      const libraryFolderPaths = new Map<number, string>();
      for (const f of folders) {
        libraryFolderPaths.set(f.id, f.path);
      }

      let progressSendCount = 0;
      const syncOpts: RunSyncOptions = {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        cancelSignal: activeSyncAbort.signal,
        ignoreSpaceCheck: opts.ignoreSpaceCheck,
        enableSyncDiagnostics: isDevMode,
        progressCallback: (progressEvent) => {
          progressSendCount++;
          const isDestroyed = event.sender.isDestroyed();
          if (progressSendCount === 1) {
            appendDebugLog({
              location: "main:firstProgress",
              message: "first progressCallback",
              data: { event: progressEvent.event, path: progressEvent.path, isDestroyed, willSend: !isDestroyed },
            });
          }
          if (!isDestroyed) {
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
      if (!willRunMusic && !willRunPodcast) {
        syncOpts.progressCallback?.({ event: "log", message: "No music, podcast or playlist to sync." });
        syncOpts.progressCallback?.({ event: "total", path: "0" });
      }

      // #region agent log
      syncDebugLog("entering music sync?", { willRunMusic }, "H1");
      // #endregion
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

      // #region agent log
      syncDebugLog("entering podcast sync?", { willRunPodcast }, "H5");
      // #endregion
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

      if (result.errors > 0) result.status = "error";
      activeSyncAbort = null;

      const shouldWritePlaylists =
        result.errors === 0 &&
        (opts.syncType === "custom"
          ? (opts.selections?.playlists?.length ?? 0) > 0
          : opts.includePlaylists !== false);

      // #region agent log
      syncDebugLog("playlist write decision", {
        shouldWritePlaylists,
        resultErrors: result.errors,
        includePlaylists: opts.includePlaylists,
        playlistFolderTruthy: !!device.getContentPath("playlist"),
      }, "H2");
      // #endregion

      if (shouldWritePlaylists) {
        const playlistFolder = device.getContentPath("playlist");
        // #region agent log
        syncDebugLog("playlist folder", {
          playlistFolder: playlistFolder ?? "(falsy)",
          hasFolder: !!playlistFolder,
        }, "H3");
        // #endregion
        if (playlistFolder) {
          try {
            const core = getPlaylistCore();
            let playlistsToWrite = core.getPlaylists();
            if (opts.syncType === "custom" && opts.selections?.playlists?.length) {
              const selectedSet = new Set(opts.selections.playlists);
              playlistsToWrite = playlistsToWrite.filter((pl) => selectedSet.has(pl.name));
            }
            // #region agent log
            syncDebugLog("playlists to write", {
              count: playlistsToWrite.length,
              names: playlistsToWrite.map((p) => p.name),
            }, "H4");
            // #endregion
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
            // #region agent log
            syncDebugLog("playlist write error", {
              error: err instanceof Error ? err.message : String(err),
            }, "H4");
            // #endregion
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

      // #region agent log
      syncDebugLog("sync handler returning", {
        status: result.status,
        synced: result.synced,
        errors: result.errors,
        progressSendCount,
      }, "H1");
      // #endregion
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
}
