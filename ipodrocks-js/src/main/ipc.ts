import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { app, BrowserWindow, dialog, ipcMain, shell, IpcMainInvokeEvent } from "electron";
import { pathMatchesAllowedPrefix } from "./path-allowlist";

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

/**
 * Allowed root prefixes for library folder paths.
 * Includes home dir (all platforms) plus platform-specific external drive roots.
 */
function getAllowedPathPrefixes(): string[] {
  const prefixes = [os.homedir()];
  if (process.platform === "darwin") {
    prefixes.push("/Volumes");
  } else if (process.platform === "linux") {
    prefixes.push("/media", "/mnt", "/run/media");
  } else if (process.platform === "win32") {
    // Allow all drive letters on Windows (C:\, D:\, etc.)
    for (let c = 65; c <= 90; c++) {
      prefixes.push(`${String.fromCharCode(c)}:\\`);
    }
  }
  return prefixes;
}

/** Validates a folder path for library operations. Returns resolved path or error. */
function validateFolderPath(rawPath: string): { path: string } | { error: string } {
  if (!rawPath || typeof rawPath !== "string") {
    return { error: "Invalid path" };
  }
  const resolved = path.resolve(rawPath.trim());

  // Verify the path exists and is a directory before resolving symlinks
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: "Path is not a directory" };
    }
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }

  // Resolve symlinks to get the real path and validate against allowed prefixes
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }

  // Verify the real (symlink-resolved) path falls under an allowed root prefix (F2)
  const allowed = getAllowedPathPrefixes();
  const isAllowed = allowed.some((prefix) =>
    pathMatchesAllowedPrefix(realPath, prefix, process.platform)
  );
  if (!isAllowed) {
    return { error: "Path is outside allowed directories" };
  }

  return { path: realPath };
}

/**
 * Check whether a device mount path is actually online (volume is mounted).
 *
 * A device is considered online only when its mount path is a real mount
 * point — i.e., a separate filesystem. We verify this by comparing the `dev`
 * (filesystem device id) of the mount path against its parent directory:
 * a real mounted volume always has a different `dev` than its parent, while
 * a regular folder on the main filesystem (or an orphan directory left behind
 * after ejection) shares the parent's `dev`.
 *
 * `fs.existsSync` alone is not reliable because:
 *   - macOS/Linux can leave an empty orphan directory after ejection
 *   - a local folder "test device" always exists but is not a connected device
 *
 * On Windows (no POSIX dev ids in a meaningful way), we fall back to checking
 * that the path exists and is a directory; Windows drive letters are naturally
 * isolated so this is sufficient there.
 */
function isDeviceMountPathOnline(mountPath: string): boolean {
  if (!mountPath) return false;
  try {
    const resolved = path.resolve(mountPath);
    const pathStat = fs.statSync(resolved);
    if (!pathStat.isDirectory()) return false;
    if (process.platform === "win32") return true;
    const parentStat = fs.statSync(path.dirname(resolved));
    return pathStat.dev !== parentStat.dev;
  } catch {
    return false;
  }
}

import {
  AddDeviceConfig,
  GeniusGenerateOptions,
  MatchedPlayEvent,
  SyncOptions,
  SmartPlaylistRule,
  DeviceSyncPreferences,
} from "../shared/types";
import {
  emptySelections,
  getDeviceSyncPreferences,
  saveDeviceSyncPreferences,
} from "./sync/device-sync-preferences";
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
import { writePlaylistsToDevice } from "./sync/playlist-sync";
import { isMpcencAvailable } from "./utils/mpcenc";
import {
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  getOpenRouterConfig,
  setOpenRouterConfig,
  getHarmonicPrefs,
  setHarmonicPrefs,
  getUpdateSnoozeUntil,
  setUpdateSnoozeUntil,
  type HarmonicPrefs,
} from "./utils/prefs";
import {
  fetchLatestRelease,
  compareVersions,
  shouldAutoCheck,
} from "./utils/update-checker";
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
  invalidateAssistantCache,
} from "./assistant/assistantChat";
import { randomUUID } from "crypto";
import { logActivity, getRecentActivity } from "./activity/activity-logger";
import { checkRateLimit } from "./llm/openRouterClient";
import {
  ingestDeviceRatings,
  computeRatingPropagations,
  markRatingsPropagated,
} from "./sync/rating-merge";
import {
  readRockboxRatings,
  writeRockboxRatingsChangelog,
  resolveDevicePathToTrackId,
  hasRockboxChangelog,
  buildDeviceRelativePath,
} from "./rockbox/tagcache";
import { prepareTrack, cancelPrepare } from "./player/player-source";
import type { Track } from "../shared/types";

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
const SESSION_CAP = 20; // F6: reduced from 50 — single-user desktop app

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

/** Periodic session cleanup timer — started once when IPC handlers are registered. */
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

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

/**
 * Removes absolute file-system paths from an error message before it is sent
 * to the renderer, preventing internal path disclosure (e.g. EACCES messages).
 * The original message is still logged in full on the main process.
 */
function sanitizeErrorMessage(message: string): string {
  return message
    // Unix absolute paths
    .replace(/(?:\/[^\s:,'"()\[\]]+)+/g, "[path]")
    // Windows absolute paths (C:\... or C:/...)
    .replace(/(?:[A-Za-z]:[/\\][^\s:,'"()\[\]]+)+/g, "[path]");
}

function safe(channel: string, fn: Handler): Handler {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      console.error(`[ipc] ${channel} — ${message}`);
      return { error: sanitizeErrorMessage(message) };
    }
  };
}

export function registerIpcHandlers(): void {
  // F6: Periodic session cleanup — runs every 5 minutes regardless of activity
  if (!sessionCleanupTimer) {
    sessionCleanupTimer = setInterval(() => {
      cleanupChatSessions(moodChatSessions);
      cleanupChatSessions(savantPlaylistChatSessions);
    }, 5 * 60 * 1000);
    // Don't prevent app quit
    sessionCleanupTimer.unref?.();
  }

  // ---- App prefs and tool availability ----
  ipcMain.handle(
    "app:isMpcencAvailable",
    safe("app:isMpcencAvailable", async () => ({ available: isMpcencAvailable() }))
  );
  ipcMain.handle(
    "app:getMpcRemindDisabled",
    safe("app:getMpcRemindDisabled", async () => ({ disabled: getMpcRemindDisabled() }))
  );
  ipcMain.handle(
    "app:setMpcRemindDisabled",
    safe("app:setMpcRemindDisabled", async (_event, disabled: boolean) => {
      setMpcRemindDisabled(disabled);
      return undefined;
    })
  );
  ipcMain.handle(
    "app:getVersion",
    safe("app:getVersion", async () => ({ version: app.getVersion() }))
  );
  ipcMain.handle(
    "app:checkForUpdates",
    safe("app:checkForUpdates", async (_event, opts?: { auto?: boolean }) => {
      const current = app.getVersion();
      if (opts?.auto) {
        const snoozeUntil = getUpdateSnoozeUntil();
        if (!shouldAutoCheck(Date.now(), snoozeUntil ?? undefined)) {
          return { current, latest: current, updateAvailable: false, snoozed: true };
        }
      }
      try {
        const release = await fetchLatestRelease();
        const latest = release.tagName.replace(/^v/, "");
        const updateAvailable = compareVersions(current, latest) === -1;
        return { current, latest, updateAvailable, htmlUrl: release.htmlUrl };
      } catch {
        return { current, latest: current, updateAvailable: false, error: "network" };
      }
    })
  );
  ipcMain.handle(
    "app:setUpdateSnooze",
    safe("app:setUpdateSnooze", async (_event, snoozeUntil: number | null) => {
      setUpdateSnoozeUntil(snoozeUntil);
      return undefined;
    })
  );
  ipcMain.handle(
    "app:openExternal",
    safe("app:openExternal", async (_event, url: string) => {
      await shell.openExternal(url);
      return undefined;
    })
  );

  // ---- Genius Playlists (register early so they are always available) ----
  ipcMain.handle(
    "genius:analyze",
    safe("genius:analyze", async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      if (!device.profile.devMode && !isDeviceMountPathOnline(device.mountPath)) {
        return { offline: true, error: "Device not connected" };
      }

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
    safe("genius:getSummaryFromDb", async () => {
      const summary = buildAnalysisSummaryFromDb(getLibrary().getConnection());
      const artists = getArtistsFromPlaybackStats(getLibrary().getConnection());
      return { summary, artists };
    })
  );

  ipcMain.handle(
    "genius:types",
    safe("genius:types", async () => getAvailableGeniusTypes(getLibrary().getConnection()))
  );

  ipcMain.handle(
    "genius:generate",
    safe("genius:generate", async (
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
    safe("genius:save", async (
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
    safe("dialog:pickFolder", async (event) => {
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
    safe("library:scan", async (event, payload: { folders: Array<{ name: string; path: string; contentType: string }> }) => {
      const lib = getLibrary();
      const scanner = new LibraryScanner(lib.getConnection());
      activeScanAbort = new AbortController();
      const harmonicPrefs = getHarmonicPrefs();

      let totalAdded = 0;
      let totalProcessed = 0;
      let totalRemoved = 0;

      const allErrors: string[] = [];
      const allAdded: string[] = [];
      const allUpdated: string[] = [];
      const allRemovedIds: number[] = [];
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
          totalRemoved += result.filesRemoved ?? 0;
          if (result.errors?.length) allErrors.push(...result.errors);
          if (result.addedTrackPaths?.length) allAdded.push(...result.addedTrackPaths);
          if (result.updatedTrackPaths?.length) allUpdated.push(...result.updatedTrackPaths);
          if (result.removedTrackIds?.length) allRemovedIds.push(...result.removedTrackIds);
          if (result.cancelled) {
            return {
              filesAdded: totalAdded,
              filesProcessed: totalProcessed,
              filesRemoved: totalRemoved,
              cancelled: true,
              errors: allErrors,
            };
          }
        }

        if (allAdded.length > 0 || allUpdated.length > 0 || allRemovedIds.length > 0) {
          lib
            .propagateScanToShadows(allAdded, allUpdated, allRemovedIds)
            .catch((err) => console.error("[ipc] Shadow propagation error:", err));
        }

        logActivity(
          getLibrary().getConnection(),
          "library_scan",
          `Scanned ${totalProcessed} files, ${totalAdded} added, ${totalRemoved} removed`
        );
        invalidateAssistantCache(); // F9: library changed, rebuild context on next chat
        return {
          filesAdded: totalAdded,
          filesProcessed: totalProcessed,
          filesRemoved: totalRemoved,
          cancelled: false,
          errors: allErrors,
        };
      } finally {
        activeScanAbort = null;
      }
    })
  );

  ipcMain.handle(
    "scan:cancel",
    safe("scan:cancel", async () => {
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
    safe("library:getTracks", async (_event, filter?: { contentType?: "music" | "podcast" | "audiobook"; limit?: number; offset?: number }) => {
      return getLibrary().getTracks(filter);
    })
  );

  ipcMain.handle(
    "library:getStats",
    safe("library:getStats", async () => getLibrary().getStats())
  );

  ipcMain.handle(
    "activity:getRecent",
    safe("activity:getRecent", async () => getRecentActivity(getLibrary().getConnection()))
  );

  ipcMain.handle(
    "library:getFolders",
    safe("library:getFolders", async () => getLibrary().getLibraryFolders())
  );

  ipcMain.handle(
    "library:addFolder",
    safe("library:addFolder", async (_event, folder: { name: string; path: string; contentType: "music" | "podcast" | "audiobook" }) => {
      const validated = validateFolderPath(folder.path);
      if ("error" in validated) return { error: validated.error };
      const result = getLibrary().addLibraryFolder(
        folder.name,
        validated.path,
        folder.contentType
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
    safe("library:removeFolder", async (_event, folderId: number) => {
      const ok = getLibrary().removeLibraryFolder(folderId, true);
      if (!ok) throw new Error("Folder not found or could not remove");
    })
  );

  ipcMain.handle(
    "library:clearContentHashes",
    safe("library:clearContentHashes", async () => getLibrary().clearContentHashes())
  );

  // ---- Shadow Libraries -------------------------------------------------

  ipcMain.handle(
    "shadow:getAll",
    safe("shadow:getAll", async () => getLibrary().getShadowLibraries())
  );

  ipcMain.handle(
    "shadow:create",
    safe("shadow:create", async (
      event,
      config: { name: string; path: string; codecConfigId: number }
    ) => {
      const validated = validateFolderPath(config.path);
      if ("error" in validated) return { error: validated.error };

      const lib = getLibrary();
      const id = lib.createShadowLibrary(
        config.name,
        validated.path,
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
    safe("shadow:delete", async (_event, shadowLibId: number, keepFilesOnDisk?: boolean) => {
      return getLibrary().deleteShadowLibrary(shadowLibId, !keepFilesOnDisk);
    })
  );

  ipcMain.handle(
    "shadow:rebuild",
    safe("shadow:rebuild", async (event, shadowLibId: number) => {
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
    safe("shadow:cancelBuild", async () => {
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
    safe("device:list", async () => {
      return getDevicesCore().getDevices().map((d) => d.profile);
    })
  );

  ipcMain.handle(
    "device:add",
    safe("device:add", async (_event, config: AddDeviceConfig) => {
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
    safe("device:getModels", async () => {
      return getLibrary().getConnection()
        .prepare("SELECT id, name, internal_value, description FROM device_models ORDER BY id")
        .all();
    })
  );

  ipcMain.handle(
    "device:getCodecConfigs",
    safe("device:getCodecConfigs", async () => {
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
    safe("device:setDefault", async (_event, deviceId: number | null) => {
      return getDevicesCore().setDefaultDevice(deviceId);
    })
  );

  ipcMain.handle(
    "device:getDefault",
    safe("device:getDefault", async () => {
      return getDevicesCore().getDefaultDeviceId();
    })
  );

  ipcMain.handle(
    "device:getSyncedPaths",
    safe("device:getSyncedPaths", async (_event, deviceId: number) => {
      const rows = getLibrary().getConnection()
        .prepare("SELECT library_path FROM device_synced_tracks WHERE device_id = ?")
        .all(deviceId) as { library_path: string }[];
      return rows.map((r) => r.library_path);
    })
  );

  ipcMain.handle(
    "device:update",
    safe("device:update", async (_event, deviceId: number, updates: Record<string, unknown>) => {
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
    safe("device:remove", async (_event, deviceId: number) => {
      return getDevicesCore().deleteDevice(deviceId);
    })
  );

  ipcMain.handle(
    "device:ping",
    safe("device:ping", async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { online: false };
      return { online: device.profile.devMode || isDeviceMountPathOnline(device.mountPath) };
    })
  );

  ipcMain.handle(
    "device:check",
    safe("device:check", async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      if (!device.profile.devMode && !isDeviceMountPathOnline(device.mountPath)) {
        return { offline: true, deviceId, name: device.name };
      }

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
      let profileCodecExt: string | null = null;
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
          profileCodecExt = getProfileCodecExt(shadowLib.codecName);
        }
      }

      if (profileCodecExt === null) {
        profileCodecExt = getProfileCodecExt(codecName);
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
        musicCodecMismatch: musicCompare.codecMismatchPaths.length,
        musicToSync: musicCompare.missingTracks.size,
        podcastSyncedWithLibrary: podcastCompare.tracksToSkip.length,
        podcastOrphans: podcastCompare.extras.length,
        podcastCodecMismatch: podcastCompare.codecMismatchPaths.length,
        podcastToSync: podcastCompare.missingTracks.size,
        audiobookSyncedWithLibrary: audiobookCompare.tracksToSkip.length,
        audiobookOrphans: audiobookCompare.extras.length,
        audiobookCodecMismatch: audiobookCompare.codecMismatchPaths.length,
        audiobookToSync: audiobookCompare.missingTracks.size,
        playlistOrphans: playlistOrphans.length,
        profileCodecName: codecName,
        orphansMusicPaths: musicCompare.extras,
        orphansPodcastPaths: podcastCompare.extras,
        orphansAudiobookPaths: audiobookCompare.extras,
        orphansPlaylistPaths: playlistOrphans,
      };
    })
  );

  ipcMain.handle(
    "device:readPlaybackLog",
    safe("device:readPlaybackLog", async (_event, deviceId: number) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };

      if (!device.profile.devMode && !isDeviceMountPathOnline(device.mountPath)) {
        return { offline: true, error: "Device not connected", ingested: 0, skipped: 0 };
      }

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
    safe("sync:start", async (event, opts: SyncOptions) => {
      const lib = getLibrary();
      const dc = getDevicesCore();
      const device = dc.getDeviceById(opts.deviceId);
      if (!device) return { error: `Device ${opts.deviceId} not found` };

      saveDeviceSyncPreferences(lib.getConnection(), opts.deviceId, {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        includeMusic: opts.includeMusic !== false,
        includePodcasts: opts.includePodcasts !== false,
        includeAudiobooks: opts.includeAudiobooks !== false,
        includePlaylists: opts.includePlaylists !== false,
        ignoreSpaceCheck: opts.ignoreSpaceCheck,
        skipAlbumArtwork: opts.skipAlbumArtwork === true,
        selections: opts.selections ?? emptySelections(),
      } satisfies DeviceSyncPreferences);

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

        // Collect track paths from selected playlists
        const playlistTrackPaths = new Set<string>();
        if (sel.playlists?.length) {
          const playlistCore = getPlaylistCore();
          const selectedPlaylistNames = new Set(sel.playlists);
          const allPlaylists = playlistCore.getPlaylists();
          for (const pl of allPlaylists) {
            if (selectedPlaylistNames.has(pl.name)) {
              for (const track of playlistCore.getPlaylistTracks(pl.id)) {
                playlistTrackPaths.add(track.path);
              }
            }
          }
        }

        const matchMusic = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const album = (String(t.album ?? "Unknown Album")).trim();
          const artist = (String(t.artist ?? "Unknown Artist")).trim();
          const genre = (String(t.genre ?? "Unknown Genre")).trim();
          const albumLabel = `${album} — ${artist}`;
          return albumSet.has(albumLabel) || artistSet.has(artist) || genreSet.has(genre);
        };
        const matchPodcast = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return podcastSet.has(label) || podcastSet.has(title);
        };
        const matchAudiobook = (t: Record<string, unknown>, p: string) => {
          if (playlistTrackPaths.has(p)) return true;
          const title = (String(t.title ?? t.filename ?? "Untitled")).trim();
          const artist = (String(t.artist ?? "")).trim();
          const label = artist ? `${title} — ${artist}` : title;
          return audiobookSet.has(label) || audiobookSet.has(title);
        };

        for (const [p, t] of Object.entries(musicMap)) {
          if (matchMusic(t, p)) musicLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(podcastMap)) {
          if (matchPodcast(t, p)) podcastLibraryTracks[p] = t;
        }
        for (const [p, t] of Object.entries(audiobookMap)) {
          if (matchAudiobook(t, p)) audiobookLibraryTracks[p] = t;
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
      let profileCodecExtOverride: string | null = null;
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
          profileCodecExtOverride = getProfileCodecExt(shadowLib.codecName);
        }
      }

      // Pre-load all content_hashes mtimes once from DB so analyzeContentType
      // can skip fs.statSync for unchanged files without per-track round-trips.
      const mtimeRows = lib.getConnection()
        .prepare("SELECT file_path, last_modified FROM content_hashes")
        .all() as { file_path: string; last_modified: string }[];
      const preloadedMtimes = new Map<string, number>();
      for (const r of mtimeRows) {
        const ms = new Date(r.last_modified).getTime();
        if (!Number.isNaN(ms)) preloadedMtimes.set(r.file_path, ms);
      }

      const syncOpts: RunSyncOptions = {
        syncType: opts.syncType,
        extraTrackPolicy: opts.extraTrackPolicy,
        cancelSignal: activeSyncAbort.signal,
        ignoreSpaceCheck: opts.ignoreSpaceCheck,
        skipAlbumArtwork: opts.skipAlbumArtwork,
        preloadedMtimes,
        profileCodecExtOverride: profileCodecExtOverride ?? undefined,
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

      // Phase 1: INGEST — read device ratings and merge into canonical DB
      try {
        if (hasRockboxChangelog(device.mountPath)) {
          syncOpts.progressCallback?.({ event: "log", message: "Reading device ratings..." });
          const deviceRatingsByPath = readRockboxRatings(device.mountPath);
          const db = lib.getConnection();

          // Resolve device-relative paths to track IDs
          const deviceRatingsByTrackId = new Map<number, number>();
          for (const [devPath, rating] of deviceRatingsByPath) {
            const trackId = resolveDevicePathToTrackId(db, opts.deviceId, devPath, device.mountPath);
            if (trackId !== null) {
              deviceRatingsByTrackId.set(trackId, rating);
            }
          }

          const ingestResult = ingestDeviceRatings(db, opts.deviceId, deviceRatingsByTrackId);

          if (ingestResult.massZeroFraction > 0.25 && deviceRatingsByPath.size > 10) {
            syncOpts.progressCallback?.({
              event: "log",
              message: `Warning: ${Math.round(ingestResult.massZeroFraction * 100)}% of device ratings are 0 — possible Rockbox DB rebuild. Ratings from device skipped pending review.`,
            });
          } else {
            const total = ingestResult.adopted + ingestResult.converged + ingestResult.conflicts;
            if (total > 0) {
              syncOpts.progressCallback?.({
                event: "log",
                message: `Ratings: ${ingestResult.adopted} adopted, ${ingestResult.converged} converged, ${ingestResult.conflicts} conflict(s) queued.`,
              });
            }
          }
        }
      } catch (err) {
        console.error("[ipc] Rating ingest failed (non-fatal):", err);
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

      const useTagnavi = device.profile.rockboxSmartPlaylists === true;
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
            syncOpts.progressCallback?.({
              event: "total_add",
              path: String(playlistsToWrite.length),
            });
            const writeResult = await writePlaylistsToDevice({
              playlistFolder,
              mountPath: device.profile.mountPath,
              playlistsToWrite,
              core,
              m3uOpts,
              useTagnavi,
              progressCallback: syncOpts.progressCallback,
            });
            playlistsWritten = writeResult.playlistsWritten;
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
            libraryPlaylists
              .filter((pl) => !(useTagnavi && pl.typeName === "smart"))
              .map((pl) =>
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

      // Phase 3: PROPAGATE — push canonical ratings back to the device
      try {
        const db = lib.getConnection();
        const propagations = computeRatingPropagations(db, opts.deviceId);

        if (propagations.size > 0) {
          // Build device-relative paths for the changelog
          const deviceMusicFolder = device.profile.musicFolder ?? "Music";

          // For each track to propagate, we need its device filename
          const trackIds = [...propagations.keys()];
          const placeholders = trackIds.map(() => "?").join(",");
          const trackRows = db
            .prepare(
              `SELECT t.id, t.filename FROM tracks t WHERE t.id IN (${placeholders})`
            )
            .all(...trackIds) as { id: number; filename: string }[];

          const entries: import("./rockbox/tagcache").RockboxRatingEntry[] = [];
          const propagatedIds: number[] = [];

          for (const row of trackRows) {
            const rating = propagations.get(row.id);
            if (rating === undefined) continue;
            entries.push({
              filePath: buildDeviceRelativePath(deviceMusicFolder, row.filename),
              rating,
            });
            propagatedIds.push(row.id);
          }

          writeRockboxRatingsChangelog(device.mountPath, entries);
          markRatingsPropagated(db, opts.deviceId, propagatedIds);

          syncOpts.progressCallback?.({
            event: "log",
            message: `Pushed ${entries.length} rating(s) to device. Run "Database → Initialize Now" on the device to apply.`,
          });
        }
      } catch (err) {
        console.error("[ipc] Rating propagation failed (non-fatal):", err);
      }

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
    safe("sync:cancel", async () => {
      if (activeSyncAbort) {
        activeSyncAbort.abort();
        activeSyncAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  ipcMain.handle(
    "sync:getDevicePreferences",
    safe("sync:getDevicePreferences", async (_e, deviceId: number) =>
      getDeviceSyncPreferences(getLibrary().getConnection(), deviceId))
  );

  // ---- Playlists ---------------------------------------------------------

  ipcMain.handle(
    "playlist:list",
    safe("playlist:list", async (_event, playlistType?: string) => {
      return getPlaylistCore().getPlaylists(playlistType);
    })
  );

  ipcMain.handle(
    "playlist:getTracks",
    safe("playlist:getTracks", async (_event, playlistId: number) => {
      return getPlaylistCore().getPlaylistTracks(playlistId);
    })
  );

  ipcMain.handle(
    "playlist:previewSmartTracks",
    safe("playlist:previewSmartTracks", async (_event, payload: { rules: SmartPlaylistRule[]; trackLimit?: number }) => {
      return getPlaylistCore().previewSmartTracks(payload.rules, payload.trackLimit);
    })
  );

  ipcMain.handle(
    "playlist:create",
    safe("playlist:create", async (_event, config: {
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
      invalidateAssistantCache(); // F9
      return p;
    })
  );

  ipcMain.handle(
    "playlist:delete",
    safe("playlist:delete", async (_event, playlistId: number) => {
      getPlaylistCore().deletePlaylist(playlistId);
      invalidateAssistantCache(); // F9
    })
  );

  ipcMain.handle(
    "playlist:export",
    safe("playlist:export", async (_event, playlistId: number, deviceId?: number) => {
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
    safe("playlist:getGenres", async () => getPlaylistCore().getGenres())
  );

  ipcMain.handle(
    "playlist:getArtists",
    safe("playlist:getArtists", async () => getPlaylistCore().getArtists())
  );

  ipcMain.handle(
    "playlist:getAlbums",
    safe("playlist:getAlbums", async () => getPlaylistCore().getAlbums())
  );

  // ---- Savant Playlists -------------------------------------------------

  ipcMain.handle(
    "savant:generate",
    safe("savant:generate", async (_event, intent: import("../shared/types").SavantIntent) => {
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
    safe("savant:checkKeyData", async () => {
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
      const bpmOnly = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND bpm IS NOT NULL AND camelot IS NULL"
        )
        .get() as { c: number };
      const coveragePct =
        total.c > 0 ? Math.round((keyed.c / total.c) * 100) : 0;
      return {
        keyedCount: keyed.c,
        totalCount: total.c,
        coveragePct,
        bpmOnlyCount: bpmOnly.c,
      };
    })
  );

  ipcMain.handle(
    "savant:backfillFeatures",
    safe("savant:backfillFeatures", async (event, opts?: { percent?: number }) => {
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
    safe("savant:backfillCancel", async () => {
      if (activeBackfillAbort) {
        activeBackfillAbort.abort();
        activeBackfillAbort = null;
      }
    })
  );

  ipcMain.handle(
    "savant:chat:start",
    safe("savant:chat:start", async () => {
      if (!checkRateLimit("savant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
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
    safe("savant:chat:turn", async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      if (!checkRateLimit("savant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      cleanupChatSessions(moodChatSessions);
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
    safe("savant:chat:skip", async (_event, sessionId: string) => {
      moodChatSessions.delete(sessionId);
    })
  );

  ipcMain.handle(
    "savant:playlistChat:start",
    safe("savant:playlistChat:start", async () => {
      if (!checkRateLimit("savant:playlistChat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
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
    safe("savant:playlistChat:turn", async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      if (!checkRateLimit("savant:playlistChat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      cleanupChatSessions(savantPlaylistChatSessions);
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
    safe("savant:playlistChat:skip", async (_event, sessionId: string) => {
      savantPlaylistChatSessions.delete(sessionId);
    })
  );

  ipcMain.handle(
    "assistant:chat",
    safe("assistant:chat", async (_event, userMessage: string) => {
      // F4: Rate limit LLM calls
      if (!checkRateLimit("assistant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
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
          // F3: Validate rule IDs against DB before trusting LLM output
          const stmtForType: Record<string, ReturnType<typeof db.prepare>> = {
            genre: db.prepare("SELECT 1 FROM genres WHERE id = ?"),
            artist: db.prepare("SELECT 1 FROM artists WHERE id = ?"),
            album: db.prepare("SELECT 1 FROM albums WHERE id = ?"),
          };
          const validatedRules = smartPlaylist.rules.filter((r) => {
            if (r.targetId == null) return true; // "all" rules have no ID
            const stmt = stmtForType[r.ruleType];
            if (!stmt) return false;
            return stmt.get(r.targetId) != null;
          });
          if (validatedRules.length > 0) {
            const core = getPlaylistCore();
            core.createSmartPlaylist(
              smartPlaylist.name,
              validatedRules,
              "",
              smartPlaylist.trackLimit
            );
            logActivity(db, "playlist_generated", `Smart: ${smartPlaylist.name}`);
            playlistCreated = smartPlaylist.name;
          }
        } else if (geniusPlaylist) {
          // F3: Validate geniusType against known types
          const validTypes = getAvailableGeniusTypes(db).map((t) => t.value);
          if (!validTypes.includes(geniusPlaylist.geniusType)) {
            console.warn(`[assistant] Invalid geniusType from LLM: ${geniusPlaylist.geniusType}`);
          } else {
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
    safe("assistant:history:load", async () => {
      const db = getLibrary().getConnection();
      return loadAssistantHistory(db);
    })
  );

  ipcMain.handle(
    "assistant:history:clear",
    safe("assistant:history:clear", async () => {
      const db = getLibrary().getConnection();
      clearAssistantHistory(db);
    })
  );

  // ---- Settings (OpenRouter) ---------------------------------------------

  ipcMain.handle(
    "settings:getOpenRouterConfig",
    safe("settings:getOpenRouterConfig", async () => {
      const cfg = getOpenRouterConfig();
      if (!cfg) return null;
      // Return a masked key so the full secret never reaches the renderer.
      // The renderer uses the mask char (•) as a sentinel meaning "unchanged".
      const { apiKey, ...rest } = cfg;
      const masked =
        apiKey && apiKey.length >= 8
          ? "••••••••" + apiKey.slice(-4)
          : "••••••••";
      return { ...rest, apiKey: masked };
    })
  );

  ipcMain.handle(
    "settings:setOpenRouterConfig",
    safe("settings:setOpenRouterConfig", async (_event, config: import("../shared/types").OpenRouterConfig | null) => {
      if (config && config.apiKey?.includes("•")) {
        // Renderer sent back the masked value — preserve the stored key; only
        // update other fields (e.g. model).
        const existing = getOpenRouterConfig();
        setOpenRouterConfig({ apiKey: existing?.apiKey ?? "", model: config.model });
      } else {
        setOpenRouterConfig(config);
      }
    })
  );

  ipcMain.handle(
    "settings:testOpenRouter",
    safe("settings:testOpenRouter", async (_event, configOverride?: { apiKey: string; model: string } | null) => {
      // If the renderer passed a masked key, ignore it and use the stored key.
      const override =
        configOverride?.apiKey?.includes("•") ? null : configOverride;
      const config = override ?? getOpenRouterConfig();
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
    safe("settings:getHarmonicPrefs", async () => getHarmonicPrefs())
  );

  ipcMain.handle(
    "settings:setHarmonicPrefs",
    safe("settings:setHarmonicPrefs", async (_event, prefs: HarmonicPrefs) => {
      setHarmonicPrefs(prefs);
    })
  );

  // ---- Ratings -----------------------------------------------------------

  ipcMain.handle(
    "ratings:setTrackRating",
    safe("ratings:setTrackRating", async (_event, trackId: number, rating: number | null) => {
      const db = getLibrary().getConnection();
      const track = db
        .prepare("SELECT id, rating FROM tracks WHERE id = ?")
        .get(trackId) as { id: number; rating: number | null } | undefined;
      if (!track) throw new Error(`Track ${trackId} not found`);

      const validRating =
        rating === null ? null : Math.max(0, Math.min(10, Math.round(rating)));

      db.prepare(`
        UPDATE tracks SET
          rating = ?,
          rating_source_device_id = NULL,
          rating_updated_at = CURRENT_TIMESTAMP,
          rating_version = rating_version + 1
        WHERE id = ?
      `).run(validRating, trackId);

      db.prepare(`
        INSERT INTO rating_events (track_id, device_id, old_rating, new_rating, source)
        VALUES (?, NULL, ?, ?, 'library_ui')
      `).run(trackId, track.rating, validRating);

      return { ok: true };
    })
  );

  ipcMain.handle(
    "ratings:getConflicts",
    safe("ratings:getConflicts", async () => {
      const db = getLibrary().getConnection();
      const rows = db
        .prepare(`
          SELECT rc.id, rc.track_id, rc.device_id, rc.reported_rating,
                 rc.baseline_rating, rc.canonical_rating, rc.reported_at,
                 rc.resolved_at, rc.resolution,
                 t.title, t.path,
                 COALESCE(a.name, 'Unknown Artist') as artist,
                 d.name as device_name
          FROM rating_conflicts rc
          JOIN tracks t ON t.id = rc.track_id
          LEFT JOIN artists a ON a.id = t.artist_id
          JOIN devices d ON d.id = rc.device_id
          WHERE rc.resolved_at IS NULL
          ORDER BY rc.reported_at DESC
        `)
        .all();
      return rows;
    })
  );

  ipcMain.handle(
    "ratings:resolveConflict",
    safe(
      "ratings:resolveConflict",
      async (
        _event,
        conflictId: number,
        resolution: "device_wins" | "canonical_wins" | "manual",
        manualRating?: number
      ) => {
        const db = getLibrary().getConnection();
        const conflict = db
          .prepare("SELECT * FROM rating_conflicts WHERE id = ?")
          .get(conflictId) as {
            id: number;
            track_id: number;
            device_id: number;
            reported_rating: number;
            canonical_rating: number | null;
          } | undefined;
        if (!conflict) throw new Error(`Conflict ${conflictId} not found`);

        const newRating =
          resolution === "device_wins"
            ? conflict.reported_rating
            : resolution === "canonical_wins"
              ? conflict.canonical_rating
              : (manualRating ?? conflict.canonical_rating);

        db.transaction(() => {
          if (newRating !== conflict.canonical_rating) {
            db.prepare(`
              UPDATE tracks SET
                rating = ?,
                rating_updated_at = CURRENT_TIMESTAMP,
                rating_version = rating_version + 1
              WHERE id = ?
            `).run(newRating, conflict.track_id);

            db.prepare(`
              INSERT INTO rating_events (track_id, device_id, old_rating, new_rating, source)
              VALUES (?, ?, ?, ?, 'conflict_resolved')
            `).run(conflict.track_id, conflict.device_id, conflict.canonical_rating, newRating);
          }

          db.prepare(`
            UPDATE rating_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = ?
            WHERE id = ?
          `).run(resolution, conflictId);
        })();

        return { ok: true, newRating };
      }
    )
  );

  // ---- Player ----
  ipcMain.handle(
    "player:prepare",
    safe("player:prepare", async (_event, track: Track, forceTranscode?: boolean) => {
      return prepareTrack(track, forceTranscode ?? false);
    })
  );
  ipcMain.handle(
    "player:cancel",
    safe("player:cancel", async () => {
      await cancelPrepare();
      return undefined;
    })
  );
}
