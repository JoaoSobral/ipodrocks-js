import { handle as bridgeHandle } from "../host/bridge";
import { safe, validateFolderPath } from "./common";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getAppVersion, getHostDialogs, getHostPlatform, getMusicPath } from "../host";
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
    // `platform` rides along because the web transport has no preload to read
    // `process.platform` from, and the renderer needs the *server's* platform
    // to decide whether Eject can work.
    safe("app:getVersion", async () => ({
      version: getAppVersion(),
      platform: getHostPlatform(),
    }))
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
    safe("app:openExternal", async (event, url: string) => {
      // **A link opens in the browser of whoever clicked it**, and for a web
      // client that is their own — not the host's. `shell.openExternal()` on
      // the desktop app hosting the server pops a window on *its* screen, in
      // *its* default browser, carrying *its* cookies: an allowlisted guest
      // could aim the owner's browser at anything reachable from that machine,
      // including services on its loopback and LAN that the guest cannot
      // otherwise touch. Same boundary as `dialog:pickFolder` below, and the
      // web renderer short-circuits to `window.open` rather than calling here.
      if (event.sessionId !== undefined) {
        return {
          ok: false,
          error: "Links open in your own browser, not on the server's screen.",
        };
      }
      return openExternalUrl(url);
    })
  );

  bridgeHandle(
    "dialog:pickFolder",
    safe("dialog:pickFolder", async (event) => {
      // **A native sheet belongs to whoever is sitting at the host**, and a web
      // client is by definition not. With the desktop app hosting the server,
      // the host *does* have dialogs, so a remote browser's "Browse" used to
      // open a Finder window on the server's screen — and the browser then hung
      // waiting for somebody standing at that machine to click it. Worse, a
      // modal sheet blocks the Electron window, so any remote client could
      // freeze the host's UI at will.
      //
      // The headless server has no dialogs and throws NO_NATIVE_DIALOG here
      // instead; either way the web UI answers this with its own directory
      // browser (`app:listDirectory`, same `validateFolderPath()` gate).
      if (event.sessionId !== undefined) {
        return {
          error:
            "A folder on the server is chosen with the built-in browser, not a " +
            "dialog on the server's screen.",
        };
      }
      return getHostDialogs().pickFolder();
    })
  );

  bridgeHandle(
    "app:hasNativeDialogs",
    safe("app:hasNativeDialogs", async (event) => ({
      // A property of the *client*, not the host: see `dialog:pickFolder`.
      available: event.sessionId === undefined && getHostDialogs().available,
    }))
  );

  bridgeHandle(
    "app:listDirectory",
    safe("app:listDirectory", async (_event, rawPath?: string | null) => {
      return listDirectory(rawPath ?? null);
    })
  );
}

// ---------------------------------------------------------------------------
// Server-side directory browser
// ---------------------------------------------------------------------------

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  /** Somewhere useful to start: the home directory and the standard mount
   *  points, so a NAS install does not open on `/` and make the user type. */
  roots: DirectoryEntry[];
  error?: string;
}

/**
 * Lists directories for the web UI's folder picker.
 *
 * **Library folders genuinely live on the server**, so this is not the device
 * picker — that one is the browser's `showDirectoryPicker()` and arrives in
 * Phase 4. The two are easy to confuse and answer opposite questions: this one
 * asks "where is the music on the machine running the scan", and gets its
 * answer from the server's own filesystem.
 *
 * Gated by `validateFolderPath()`, the same function that gates
 * `library:addFolder`. Listing a path the user could not then add would be an
 * enumeration oracle for the server's filesystem and nothing else.
 */
export function listDirectory(rawPath: string | null): DirectoryListing {
  const roots = defaultRoots();
  const target = rawPath?.trim() ? rawPath.trim() : os.homedir();

  const validated = validateFolderPath(target);
  if ("error" in validated) {
    return { path: target, parent: null, entries: [], roots, error: validated.error };
  }

  let entries: DirectoryEntry[];
  try {
    entries = fs
      .readdirSync(validated.path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: path.join(validated.path, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    return {
      path: validated.path,
      parent: null,
      entries: [],
      roots,
      error: err instanceof Error ? err.message : "Could not read directory",
    };
  }

  // The parent is only offered when it is itself a legal library folder, so
  // "up" can never walk out of the allowed prefixes.
  const parentPath = path.dirname(validated.path);
  const parent =
    parentPath !== validated.path && "path" in validateFolderPath(parentPath)
      ? parentPath
      : null;

  return { path: validated.path, parent, entries, roots };
}

function defaultRoots(): DirectoryEntry[] {
  const roots: DirectoryEntry[] = [
    { name: "Home", path: os.homedir() },
    { name: "Music", path: getMusicPath() },
  ];
  const platform = getHostPlatform();
  const mountRoots =
    platform === "darwin"
      ? ["/Volumes"]
      : platform === "linux"
        ? ["/media", "/mnt", "/run/media"]
        : [];
  for (const root of mountRoots) {
    try {
      if (fs.existsSync(root)) roots.push({ name: root, path: root });
    } catch {
      // Unreadable mount root; simply not offered.
    }
  }
  return roots.filter((r, i, all) => all.findIndex((o) => o.path === r.path) === i);
}
