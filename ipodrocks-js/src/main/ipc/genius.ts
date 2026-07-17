import { ipcMain } from "electron";
import { safe, getLibrary, getPlaylistCore } from "./common";
import {
  buildAnalysisSummaryFromDb,
  generateGeniusPlaylistFromDb,
  getArtistsFromPlaybackStats,
  getGeniusTypesWithAvailability,
} from "../playlists/genius-engine";
import { logActivity } from "../activity/activity-logger";
import type { GeniusGenerateOptions } from "../../shared/types";

export function registerGeniusHandlers(): void {
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
    safe("genius:types", async () =>
      getGeniusTypesWithAvailability(getLibrary().getConnection())
    )
  );

  ipcMain.handle(
    "genius:generate",
    safe("genius:generate", async (
      _event,
      _deviceId: number | null,
      geniusType: string,
      opts: GeniusGenerateOptions
    ) => {
      const db = getLibrary().getConnection();
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
