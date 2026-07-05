import { dialog, ipcMain } from "electron";
import { safe, getLibrary, getDevicesCore } from "./common";
import { searchPodcasts } from "../podcasts/podcast-index-client";
import {
  listSubscriptions,
  subscribe as podcastSubscribe,
  unsubscribe as podcastUnsubscribe,
  deleteEpisodes as podcastDeleteEpisodes,
  setAutoCount,
  listEpisodes,
  setManualSelection,
} from "../podcasts/podcast-subscriptions";
import { refreshSubscription, refreshAllForNewFolder } from "../podcasts/podcast-refresh";
import { discoverFeeds, fetchAndParseFeed, feedPreview, importFeed } from "../podcasts/podcast-feed-import";
import { syncPodcastsToDevice } from "../podcasts/podcast-device-sync";
import { startPodcastScheduler, stopPodcastScheduler } from "../podcasts/podcast-scheduler";
import { getDefaultPodcastsRoot } from "../podcasts/podcast-storage";
import {
  readPrefs,
  getPodcastIndexConfig,
  setPodcastIndexConfig,
  getAutoPodcastSettings,
  setAutoPodcastSettings,
} from "../utils/prefs";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { PodcastSearchResult } from "../../shared/types";

export function registerPodcastHandlers(): void {
  ipcMain.handle(
    "podcast:search",
    safe("podcast:search", async (_event, term: string) => {
      const config = getPodcastIndexConfig();
      if (!config) return { error: "NO_CREDS" };
      return searchPodcasts(term, config.apiKey, config.apiSecret);
    })
  );

  ipcMain.handle(
    "podcast:listSubs",
    safe("podcast:listSubs", async () => {
      const db = getLibrary().getConnection();
      return listSubscriptions(db);
    })
  );

  ipcMain.handle(
    "podcast:subscribe",
    safe("podcast:subscribe", async (_event, feed: PodcastSearchResult) => {
      const db = getLibrary().getConnection();
      const result = podcastSubscribe(db, feed);
      invalidateAssistantCache(); // F9: podcast config changed
      return result;
    })
  );

  ipcMain.handle(
    "podcast:unsubscribe",
    safe("podcast:unsubscribe", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      podcastUnsubscribe(db, subId);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  ipcMain.handle(
    "podcast:deleteEpisodes",
    safe("podcast:deleteEpisodes", async (_event, episodeIds: number[]) => {
      const db = getLibrary().getConnection();
      podcastDeleteEpisodes(db, episodeIds);
      return undefined;
    })
  );

  ipcMain.handle(
    "podcast:setAutoCount",
    safe("podcast:setAutoCount", async (_event, subId: number, count: number) => {
      const db = getLibrary().getConnection();
      setAutoCount(db, subId, count);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  ipcMain.handle(
    "podcast:listEpisodes",
    safe("podcast:listEpisodes", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      return listEpisodes(db, subId);
    })
  );

  ipcMain.handle(
    "podcast:setManualSelection",
    safe("podcast:setManualSelection", async (_event, subId: number, episodeIds: number[]) => {
      const db = getLibrary().getConnection();
      setManualSelection(db, subId, episodeIds);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  ipcMain.handle(
    "podcast:downloadNow",
    safe("podcast:downloadNow", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      const config = getPodcastIndexConfig();
      await refreshSubscription(db, subId, config?.apiKey ?? "", config?.apiSecret ?? "");
      return { ok: true };
    })
  );

  ipcMain.handle(
    "podcast:refreshAllForNewFolder",
    safe("podcast:refreshAllForNewFolder", async () => {
      const db = getLibrary().getConnection();
      const config = getPodcastIndexConfig();
      await refreshAllForNewFolder(db, config?.apiKey ?? "", config?.apiSecret ?? "");
      return { ok: true };
    })
  );

  ipcMain.handle(
    "podcast:discoverFeeds",
    safe("podcast:discoverFeeds", async (_event, input: string) => {
      return discoverFeeds(input);
    })
  );

  ipcMain.handle(
    "podcast:previewFeed",
    safe("podcast:previewFeed", async (_event, feedUrl: string) => {
      const parsed = await fetchAndParseFeed(feedUrl);
      return feedPreview(parsed);
    })
  );

  ipcMain.handle(
    "podcast:subscribeByUrl",
    safe("podcast:subscribeByUrl", async (_event, feedUrl: string) => {
      const db = getLibrary().getConnection();
      const result = await importFeed(db, feedUrl);
      invalidateAssistantCache();
      return result;
    })
  );

  ipcMain.handle(
    "podcast:syncDeviceNow",
    safe("podcast:syncDeviceNow", async (_event, deviceId: number) => {
      const db = getLibrary().getConnection();
      return syncPodcastsToDevice(db, deviceId);
    })
  );

  ipcMain.handle(
    "podcast:getSettings",
    safe("podcast:getSettings", async () => {
      const prefs = readPrefs();
      const raw = prefs.podcastIndexConfig;
      const autoSettings = getAutoPodcastSettings();
      // Never return plaintext credentials to the renderer (F1) — only booleans
      // indicating whether each is configured.
      return {
        hasApiKey: !!raw?.apiKey?.trim(),
        hasApiSecret: !!raw?.apiSecret?.trim(),
        autoEnabled: autoSettings.enabled,
        intervalMin: autoSettings.refreshIntervalMinutes,
        downloadDir: getDefaultPodcastsRoot(),
        downloadDirCustom: prefs.autoPodcasts?.downloadDir ?? null,
      };
    })
  );

  ipcMain.handle(
    "podcast:setSettings",
    safe("podcast:setSettings", async (
      _event,
      payload: { apiKey?: string; apiSecret?: string; autoEnabled?: boolean; intervalMin?: number; downloadDir?: string | null }
    ) => {
      if (payload.apiKey !== undefined || payload.apiSecret !== undefined) {
        const current = getPodcastIndexConfig() ?? { apiKey: "", apiSecret: "" };
        setPodcastIndexConfig({
          apiKey: payload.apiKey ?? current.apiKey,
          apiSecret: payload.apiSecret ?? current.apiSecret,
        });
      }

      const intervalChanged =
        payload.intervalMin !== undefined &&
        payload.intervalMin !== getAutoPodcastSettings().refreshIntervalMinutes;

      if (payload.autoEnabled !== undefined || payload.intervalMin !== undefined || "downloadDir" in payload) {
        setAutoPodcastSettings({
          enabled: payload.autoEnabled,
          refreshIntervalMinutes: payload.intervalMin,
          downloadDir: payload.downloadDir ?? undefined,
        });
      }

      // Restart the scheduler when the refresh interval changes so the new
      // cadence takes effect without requiring an app restart.
      if (intervalChanged) {
        stopPodcastScheduler();
        startPodcastScheduler(getLibrary().getConnection());
      }
      return undefined;
    })
  );

  ipcMain.handle(
    "podcast:browseDownloadDir",
    safe("podcast:browseDownloadDir", async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Select Podcast Download Folder",
        defaultPath: getDefaultPodcastsRoot(),
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    })
  );

  ipcMain.handle(
    "podcast:setDeviceAutoPodcasts",
    safe("podcast:setDeviceAutoPodcasts", async (_event, deviceId: number, enabled: boolean) => {
      getDevicesCore().updateDevice(deviceId, { autoPodcastsEnabled: enabled });
      return undefined;
    })
  );

  // Start the podcast background scheduler
  startPodcastScheduler(getLibrary().getConnection());
}
