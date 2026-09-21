import { handle as bridgeHandle } from "../host/bridge";
import { getHostDialogs } from "../host";
import { safe, getLibrary, getDevicesCore } from "./common";
import { autoPodcastBlock } from "../../shared/device-locality";
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
  bridgeHandle(
    "podcast:search",
    safe("podcast:search", async (_event, term: string) => {
      const config = getPodcastIndexConfig();
      if (!config) return { error: "NO_CREDS" };
      return searchPodcasts(term, config.apiKey, config.apiSecret);
    })
  );

  bridgeHandle(
    "podcast:listSubs",
    safe("podcast:listSubs", async () => {
      const db = getLibrary().getConnection();
      return listSubscriptions(db);
    })
  );

  bridgeHandle(
    "podcast:subscribe",
    safe("podcast:subscribe", async (_event, feed: PodcastSearchResult) => {
      const db = getLibrary().getConnection();
      const result = podcastSubscribe(db, feed);
      invalidateAssistantCache(); // F9: podcast config changed
      return result;
    })
  );

  bridgeHandle(
    "podcast:unsubscribe",
    safe("podcast:unsubscribe", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      podcastUnsubscribe(db, subId);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  bridgeHandle(
    "podcast:deleteEpisodes",
    safe("podcast:deleteEpisodes", async (_event, episodeIds: number[]) => {
      const db = getLibrary().getConnection();
      podcastDeleteEpisodes(db, episodeIds);
      return undefined;
    })
  );

  bridgeHandle(
    "podcast:setAutoCount",
    safe("podcast:setAutoCount", async (_event, subId: number, count: number) => {
      const db = getLibrary().getConnection();
      setAutoCount(db, subId, count);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  bridgeHandle(
    "podcast:listEpisodes",
    safe("podcast:listEpisodes", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      return listEpisodes(db, subId);
    })
  );

  bridgeHandle(
    "podcast:setManualSelection",
    safe("podcast:setManualSelection", async (_event, subId: number, episodeIds: number[]) => {
      const db = getLibrary().getConnection();
      setManualSelection(db, subId, episodeIds);
      invalidateAssistantCache(); // F9: podcast config changed
      return undefined;
    })
  );

  bridgeHandle(
    "podcast:downloadNow",
    safe("podcast:downloadNow", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      const config = getPodcastIndexConfig();
      await refreshSubscription(db, subId, config?.apiKey ?? "", config?.apiSecret ?? "");
      return { ok: true };
    })
  );

  bridgeHandle(
    "podcast:refreshAllForNewFolder",
    safe("podcast:refreshAllForNewFolder", async () => {
      const db = getLibrary().getConnection();
      const config = getPodcastIndexConfig();
      await refreshAllForNewFolder(db, config?.apiKey ?? "", config?.apiSecret ?? "");
      return { ok: true };
    })
  );

  bridgeHandle(
    "podcast:discoverFeeds",
    safe("podcast:discoverFeeds", async (_event, input: string) => {
      return discoverFeeds(input);
    })
  );

  bridgeHandle(
    "podcast:previewFeed",
    safe("podcast:previewFeed", async (_event, feedUrl: string) => {
      const parsed = await fetchAndParseFeed(feedUrl);
      return feedPreview(parsed);
    })
  );

  bridgeHandle(
    "podcast:subscribeByUrl",
    safe("podcast:subscribeByUrl", async (_event, feedUrl: string) => {
      const db = getLibrary().getConnection();
      const result = await importFeed(db, feedUrl);
      invalidateAssistantCache();
      return result;
    })
  );

  bridgeHandle(
    "podcast:syncDeviceNow",
    safe("podcast:syncDeviceNow", async (_event, deviceId: number) => {
      const db = getLibrary().getConnection();
      // Hand the device's own filesystem down. Without it this falls back to
      // `deviceFsForMountPath`, which for a browser-held device is a
      // `NodeDeviceFs` over the synthetic root and refuses every path.
      const device = getDevicesCore().getDeviceById(deviceId);
      return syncPodcastsToDevice(db, deviceId, undefined, device?.fs);
    })
  );

  bridgeHandle(
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

  bridgeHandle(
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

  bridgeHandle(
    "podcast:browseDownloadDir",
    safe("podcast:browseDownloadDir", async () => {
      return getHostDialogs().pickFolder({
        title: "Select Podcast Download Folder",
        defaultPath: getDefaultPodcastsRoot(),
      });
    })
  );

  bridgeHandle(
    "podcast:setDeviceAutoPodcasts",
    safe("podcast:setDeviceAutoPodcasts", async (_event, deviceId: number, enabled: boolean) => {
      const device = getDevicesCore().getDeviceById(deviceId);
      if (!device) return { error: `Device ${deviceId} not found` };
      // Turning it *off* is always allowed — a device that should not have had
      // it must be able to give it up, whatever it is.
      const blocked = enabled ? autoPodcastBlock(device.profile.transport) : null;
      if (blocked) return { error: blocked };
      getDevicesCore().updateDevice(deviceId, { autoPodcastsEnabled: enabled });
      return undefined;
    })
  );

  // Start the podcast background scheduler
  startPodcastScheduler(getLibrary().getConnection());
}
