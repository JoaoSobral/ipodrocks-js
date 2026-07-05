import * as fs from "fs";
import * as path from "path";
import { ipcMain } from "electron";
import {
  safe,
  getLibrary,
  getPlaylistCore,
  getDevicesCore,
  buildLibraryTrackMaps,
  remapTrackMapToShadow,
} from "./common";
import { isDeviceMountPathOnline } from "../devices/device-online";
import { getDeviceSyncPreferences } from "../sync/device-sync-preferences";
import { buildLibraryDestMap, getProfileCodecExt } from "../sync/sync-core";
import { compareLibraries } from "../sync/name-size-sync";
import { readAndIngestPlaybackLog } from "../playlists/playback-log-ingest";
import {
  buildAnalysisSummaryFromDb,
  getArtistsFromPlaybackStats,
} from "../playlists/genius-engine";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { AddDeviceConfig } from "../../shared/types";

export function registerDeviceHandlers(): void {
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
      invalidateAssistantCache(); // F9: device config changed
      return device.profile;
    })
  );

  ipcMain.handle(
    "device:getModels",
    safe("device:getModels", async () => {
      return getLibrary().getConnection()
        .prepare("SELECT id, name, internal_value, description FROM device_models ORDER BY name")
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
      invalidateAssistantCache(); // F9: device config changed
      return device;
    })
  );

  ipcMain.handle(
    "device:remove",
    safe("device:remove", async (_event, deviceId: number) => {
      const result = getDevicesCore().deleteDevice(deviceId);
      invalidateAssistantCache(); // F9: device config changed
      return result;
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

      const [musicStats, podcastStats, audiobookStats, playlistStats] = await Promise.all([
        device.getContentStats("music"),
        device.getContentStats("podcast"),
        device.getContentStats("audiobook"),
        device.getContentStats("playlist"),
      ]);
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

      const checkPrefs = getDeviceSyncPreferences(lib.getConnection(), deviceId);
      const preserveFolderStructure = checkPrefs?.preserveFolderStructure !== false;

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

        libraryMusicMap = remapTrackMapToShadow(libraryMusicMap, shadowTrackMap);
        libraryPodcastMap = remapTrackMapToShadow(libraryPodcastMap, shadowTrackMap);
        libraryAudiobookMap = remapTrackMapToShadow(libraryAudiobookMap, shadowTrackMap);

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

      const [deviceMusicRaw, devicePodcastRaw, deviceAudiobookRaw] = await Promise.all([
        device.getTracks("music"),
        device.getTracks("podcast"),
        device.getTracks("audiobook"),
      ]);
      const deviceMusicMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of deviceMusicRaw) {
        deviceMusicMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
      const devicePodcastMap: Record<string, { file_size: number; mtime?: number }> = {};
      for (const [p, info] of devicePodcastRaw) {
        devicePodcastMap[p] = {
          file_size: info.fileSize ?? 0,
          ...(info.mtimeMs != null && { mtime: info.mtimeMs }),
        };
      }
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
        libraryFolderPaths,
        undefined,
        undefined,
        undefined,
        preserveFolderStructure
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
        libraryFolderPaths,
        undefined,
        undefined,
        undefined,
        preserveFolderStructure
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
        libraryFolderPaths,
        undefined,
        undefined,
        undefined,
        preserveFolderStructure
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
}
