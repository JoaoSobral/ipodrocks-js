import { handle as bridgeHandle } from "../host/bridge";
import { safe } from "./common";
import { getAppVersion, getHostDialogs } from "../host";
import { openExternalUrl } from "../utils/external-url";
import { isMpcencAvailable } from "../utils/mpcenc";
import {
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  getUpdateSnoozeUntil,
  setUpdateSnoozeUntil,
  getLastAutoUpdateCheckAt,
  setLastAutoUpdateCheckAt,
  getUpdateCheckTimestamps,
  setUpdateCheckTimestamps,
} from "../utils/prefs";
import {
  fetchLatestRelease,
  fetchChangelogMarkdown,
  compareVersions,
  shouldAutoCheck,
  checkRateLimit,
} from "../utils/update-checker";
import { extractChangelogSection } from "../utils/changelog-parser";

export function registerAppHandlers(): void {
  bridgeHandle(
    "app:isMpcencAvailable",
    safe("app:isMpcencAvailable", async () => ({ available: isMpcencAvailable() }))
  );
  bridgeHandle(
    "app:getMpcRemindDisabled",
    safe("app:getMpcRemindDisabled", async () => ({ disabled: getMpcRemindDisabled() }))
  );
  bridgeHandle(
    "app:setMpcRemindDisabled",
    safe("app:setMpcRemindDisabled", async (_event, disabled: boolean) => {
      setMpcRemindDisabled(disabled);
      return undefined;
    })
  );
  bridgeHandle(
    "app:getVersion",
    safe("app:getVersion", async () => ({ version: getAppVersion() }))
  );
  bridgeHandle(
    "app:checkForUpdates",
    safe("app:checkForUpdates", async (_event, opts?: { auto?: boolean }) => {
      const current = getAppVersion();
      const now = Date.now();
      if (opts?.auto) {
        // The automatic check runs on every mount of the Welcome panel, so it
        // gets its own once-a-day throttle and stays out of the manual budget
        // below — otherwise a few visits to the tab would leave the button
        // permanently rate-limited.
        const snoozeUntil = getUpdateSnoozeUntil();
        const lastAuto = getLastAutoUpdateCheckAt();
        if (!shouldAutoCheck(now, snoozeUntil ?? undefined, lastAuto ?? undefined)) {
          return { current, latest: current, updateAvailable: false, snoozed: true };
        }
        setLastAutoUpdateCheckAt(now);
      } else {
        // Cap manual checks per hour so this app instance can't burn through
        // GitHub's unauthenticated 60/hour rate limit.
        const rate = checkRateLimit(getUpdateCheckTimestamps(), now);
        if (!rate.allowed) {
          return { current, latest: current, updateAvailable: false, error: "rate-limited" };
        }
        setUpdateCheckTimestamps(rate.timestamps);
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
  bridgeHandle(
    "app:setUpdateSnooze",
    safe("app:setUpdateSnooze", async (_event, snoozeUntil: number | null) => {
      setUpdateSnoozeUntil(snoozeUntil);
      return undefined;
    })
  );
  bridgeHandle(
    "app:fetchChangelogSection",
    safe("app:fetchChangelogSection", async (_event, opts: { version: string }) => {
      const version = (opts?.version ?? "").trim();
      if (!version) return { markdown: null, error: "version" };
      const text = await fetchChangelogMarkdown();
      if (text === null) return { markdown: null, error: "network" };
      const section = extractChangelogSection(text, version);
      return { markdown: section };
    })
  );
  bridgeHandle(
    "app:openExternal",
    safe("app:openExternal", async (_event, url: string) => {
      return openExternalUrl(url);
    })
  );

  bridgeHandle(
    "dialog:pickFolder",
    safe("dialog:pickFolder", async () => {
      // Hosts without a screen (the headless server) throw NO_NATIVE_DIALOG
      // here; the web UI answers this channel with its own directory browser
      // rather than expecting a native sheet on the server's desktop.
      return getHostDialogs().pickFolder();
    })
  );
}
