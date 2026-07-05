import { dialog, ipcMain } from "electron";
import { safe, getLibrary, getPlaylistCore, getDevicesCore } from "./common";
import { getDeviceSyncPreferences } from "../sync/device-sync-preferences";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { SmartPlaylistRule } from "../../shared/types";

export function registerPlaylistHandlers(): void {
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
      let preserveFolderStructure = true;
      if (deviceId != null) {
        const dc = getDevicesCore();
        const device = dc.getDeviceById(deviceId);
        if (device?.profile) {
          musicFolder = device.profile.musicFolder ?? "Music";
          codecName = device.profile.codecName ?? "COPY";
        }
        const prefs = getDeviceSyncPreferences(lib.getConnection(), deviceId);
        preserveFolderStructure = prefs?.preserveFolderStructure !== false;
      }

      return core.exportPlaylistM3u(playlistId, filePath, {
        musicFolder,
        codecName,
        libraryFolderPaths,
        preserveFolderStructure,
      });
    })
  );

  ipcMain.handle(
    "playlist:getBroken",
    safe("playlist:getBroken", async () => getPlaylistCore().getBrokenPlaylists())
  );

  ipcMain.handle(
    "playlist:repair",
    safe("playlist:repair", async (_event, playlistId: number) => {
      const result = getPlaylistCore().repairPlaylist(playlistId);
      logActivity(getLibrary().getConnection(), "playlist_repaired", `Repaired playlist #${playlistId}: removed ${result.removed} missing tracks`);
      invalidateAssistantCache();
      return result;
    })
  );

  ipcMain.handle(
    "playlist:rebuild",
    safe("playlist:rebuild", async (_event, playlistId: number) => {
      const ok = getPlaylistCore().rebuildSmartPlaylist(playlistId);
      if (ok) invalidateAssistantCache();
      return { rebuilt: ok };
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
}
