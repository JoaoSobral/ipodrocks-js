import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { safe } from "./common";
import { openExternalUrl } from "../utils/external-url";
import { isMpcencAvailable } from "../utils/mpcenc";
import {
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  getUpdateSnoozeUntil,
  setUpdateSnoozeUntil,
} from "../utils/prefs";
import {
  fetchLatestRelease,
  fetchChangelogMarkdown,
  compareVersions,
  shouldAutoCheck,
} from "../utils/update-checker";
import { extractChangelogSection } from "../utils/changelog-parser";

export function registerAppHandlers(): void {
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
  ipcMain.handle(
    "app:openExternal",
    safe("app:openExternal", async (_event, url: string) => {
      return openExternalUrl(url);
    })
  );

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
}
