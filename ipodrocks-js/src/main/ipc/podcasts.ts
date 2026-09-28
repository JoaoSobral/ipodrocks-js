import { handle as bridgeHandle } from "../host/bridge";
import { getHostDialogs } from "../host";
import {
  safe,
  blockWebClientDialog,
  getLibrary,
  getDevicesCore,
  validateFolderPath,
} from "./common";
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
  isValidPodcastInterval,
  PODCAST_INTERVAL_MIN_MINUTES,
  PODCAST_INTERVAL_MAX_MINUTES,
} from "../utils/prefs";
import { denyIfNotOwner } from "../../server/auth/sessions";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { PodcastSearchResult } from "../../shared/types";

/** What `podcast:setSettings` is sent. Every field is untrusted JSON. */
interface PodcastSettingsPayload {
  apiKey?: unknown;
  apiSecret?: unknown;
  autoEnabled?: unknown;
  intervalMin?: unknown;
  downloadDir?: unknown;
}

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
    safe("podcast:setSettings", async (event, raw: unknown) => {
      // Server-wide configuration, and three separate findings' worth of it:
      // `downloadDir` is a root the downloader writes feed-supplied bytes
      // into, the Podcast Index credentials are the owner's account, and the
      // interval reaches `setInterval`. So a non-owner web session may not
      // change any of it. A call that changes nothing is let through quietly
      // — the Settings card saves every section at once, and a guest saving
      // their own preferences sends these values straight back.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { error: "Invalid podcast settings" };
      }
      const payload = raw as PodcastSettingsPayload;

      const current = getAutoPodcastSettings();
      const storedDir = readPrefs().autoPodcasts?.downloadDir ?? null;
      const requestedDir =
        "downloadDir" in payload ? (payload.downloadDir ?? null) : storedDir;
      const dirChanged = requestedDir !== storedDir;
      const intervalChanged =
        payload.intervalMin !== undefined &&
        payload.intervalMin !== current.refreshIntervalMinutes;
      const enabledChanged =
        payload.autoEnabled !== undefined && payload.autoEnabled !== current.enabled;
      const credsChanged = payload.apiKey !== undefined || payload.apiSecret !== undefined;

      if (!dirChanged && !intervalChanged && !enabledChanged && !credsChanged) {
        return undefined;
      }
      const notOwner = denyIfNotOwner(event.sessionId);
      if (notOwner) {
        return { error: "Only the server's owner can change the podcast settings." };
      }

      // Validate everything before writing anything, so a rejected call
      // leaves every stored value — and the running scheduler — untouched.
      if (
        (payload.apiKey !== undefined && typeof payload.apiKey !== "string") ||
        (payload.apiSecret !== undefined && typeof payload.apiSecret !== "string")
      ) {
        return { error: "Podcast Index credentials must be strings" };
      }
      if (payload.autoEnabled !== undefined && typeof payload.autoEnabled !== "boolean") {
        return { error: "autoEnabled must be true or false" };
      }
      if (payload.intervalMin !== undefined && !isValidPodcastInterval(payload.intervalMin)) {
        return {
          error:
            `Refresh interval must be a whole number of minutes between ` +
            `${PODCAST_INTERVAL_MIN_MINUTES} and ${PODCAST_INTERVAL_MAX_MINUTES}`,
        };
      }
      // The same client-path -> server-FS guard every other folder a client
      // names goes through (`library:addFolder`, `shadow:create`). Checked
      // only when the folder actually changes, so re-saving a value that was
      // valid when it was chosen does not start failing if the rules tighten.
      let downloadDir: string | undefined;
      if (dirChanged && requestedDir !== null) {
        if (typeof requestedDir !== "string") return { error: "Invalid download folder" };
        const checked = validateFolderPath(requestedDir);
        if ("error" in checked) return { error: `Download folder: ${checked.error}` };
        downloadDir = checked.path;
      }

      if (credsChanged) {
        const creds = getPodcastIndexConfig() ?? { apiKey: "", apiSecret: "" };
        setPodcastIndexConfig({
          apiKey: (payload.apiKey as string | undefined) ?? creds.apiKey,
          apiSecret: (payload.apiSecret as string | undefined) ?? creds.apiSecret,
        });
      }

      if (enabledChanged || intervalChanged || dirChanged) {
        setAutoPodcastSettings({
          ...(payload.autoEnabled !== undefined ? { enabled: payload.autoEnabled as boolean } : {}),
          ...(payload.intervalMin !== undefined
            ? { refreshIntervalMinutes: payload.intervalMin as number }
            : {}),
          // `undefined` here is "back to the default folder".
          ...(dirChanged ? { downloadDir } : {}),
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
    safe("podcast:browseDownloadDir", async (event) => {
      const noDialog = blockWebClientDialog(event);
      if (noDialog) return noDialog;
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
