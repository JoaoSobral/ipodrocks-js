import { ipcMain } from "electron";
import { safe, getLibrary, getPlaylistCore, getDevicesCore } from "./common";
import { isDeviceMountPathOnline } from "../devices/device-online";
import { parseRockboxPlaybackLog } from "../playlists/rockbox-log-parser";
import {
  buildAnalysisSummary,
  buildAnalysisSummaryFromDb,
  generateGeniusPlaylist,
  generateGeniusPlaylistFromDb,
  getArtistsFromEvents,
  getArtistsFromPlaybackStats,
  getAvailableGeniusTypes,
  matchEventsToLibrary,
} from "../playlists/genius-engine";
import { logActivity } from "../activity/activity-logger";
import type { GeniusGenerateOptions, MatchedPlayEvent } from "../../shared/types";

/** In-memory cache of matched playback events keyed by device ID. */
const geniusEventsCache = new Map<number, MatchedPlayEvent[]>();

export function registerGeniusHandlers(): void {
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
}
