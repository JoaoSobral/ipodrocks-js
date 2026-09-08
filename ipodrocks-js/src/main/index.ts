import { app, BrowserWindow, Menu, MenuItem } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpcHandlers, getLibraryDb, resumeInterruptedShadowBuilds } from "./ipc";
import { openExternalUrl } from "./utils/external-url";
import { registerMediaScheme, registerMediaProtocol } from "./player/media-protocol";
import { cleanupPlayerTemp } from "./player/player-source";
import { stopPodcastScheduler } from "./podcasts/podcast-scheduler";
import { setLibrivoxBaseUrl } from "./audiobooks/librivox-client";
import { setCoverApiBaseUrls } from "./audiobooks/cover-client";
import { backfillMissingCovers } from "./audiobooks/audiobook-cover";

// Prevent SharedImageManager/mailbox GPU overlay errors on macOS
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

registerMediaScheme();

// Allow test env to redirect external API calls to local stubs
if (process.env.LIBRIVOX_BASE_URL) setLibrivoxBaseUrl(process.env.LIBRIVOX_BASE_URL);
setCoverApiBaseUrls({
  googleBooks: process.env.GOOGLE_BOOKS_BASE_URL,
  openLibrary: process.env.OPENLIBRARY_BASE_URL,
  openLibraryCovers: process.env.OPENLIBRARY_COVERS_BASE_URL,
});

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

function iconNamesForPlatform(): string[] {
  if (process.platform === "win32") {
    return ["icon.ico", "icon.png"];
  }
  if (process.platform === "darwin") {
    return ["icon.icns", "icon.png"];
  }
  return ["icon.png"];
}

function getIconPath(): string {
  const names = iconNamesForPlatform();
  if (app.isPackaged) {
    for (const name of names) {
      const p = path.join(process.resourcesPath, name);
      if (fs.existsSync(p)) return p;
    }
    return path.join(process.resourcesPath, names[0]);
  }
  const baseDirs = [
    path.join(app.getAppPath(), "resources"),
    path.join(__dirname, "../../../resources"),
    path.join(process.cwd(), "resources"),
  ];
  for (const name of names) {
    for (const dir of baseDirs) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(baseDirs[0], names[0]);
}

function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on("context-menu", (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    const items: MenuItem[] = [
      new MenuItem({
        label: "Cut",
        role: "cut",
        enabled: params.isEditable && hasSelection,
      }),
      new MenuItem({
        label: "Copy",
        role: "copy",
        enabled: hasSelection,
      }),
      new MenuItem({
        label: "Paste",
        role: "paste",
        enabled: params.isEditable && params.editFlags.canPaste,
      }),
      new MenuItem({ type: "separator" }),
      new MenuItem({
        label: "Select All",
        role: "selectAll",
        enabled: params.editFlags.canSelectAll,
      }),
    ];

    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

/**
 * Run without showing the window. Set only by `tests/e2e/electron-launcher.ts`;
 * nothing in a shipped build sets it, and an app that never shows a window is
 * useless to a user, so this must stay opt-in.
 */
const HEADLESS = process.env.IPODROCKS_HEADLESS === "1";

function createWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, "preload.js");
  const iconPath = getIconPath();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0d1015",
    titleBarStyle: "hiddenInset",
    icon: iconPath,
    // The e2e suite drives the renderer over CDP, which needs a live window but
    // not a visible one. Keeping it off screen stops ninety-odd Electron
    // launches stealing focus from whatever the developer is doing; CI gets the
    // same effect from its virtual display.
    show: !HEADLESS,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles timers in a window that is hidden or occluded, which
      // would turn every test that waits on one into a slow flake. Only relaxed
      // for the hidden window above — a real backgrounded window should still
      // throttle.
      backgroundThrottling: !HEADLESS,
    },
  });

  // Deny in-app window creation; route external http(s)/mailto links to the
  // OS browser. Without this, a `target="_blank"` link (including one rendered
  // from LLM/feed content) would open a child window that inherits this
  // window's preload — exposing the full `window.api` IPC bridge to it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: "deny" };
  });

  // Block the top-level frame from navigating away from the app itself.
  const isInternalUrl = (url: string): boolean => {
    if (devServerUrl && url.startsWith(devServerUrl)) return true;
    return url.startsWith("file://");
  };
  win.webContents.on("will-navigate", (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      void openExternalUrl(url);
    }
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "bottom" });
  } else {
    win.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  // A hidden window still puts the app in the Dock and pulls focus there on
  // launch, which is most of what the headless mode exists to avoid.
  if (HEADLESS) app.dock?.hide();
  cleanupPlayerTemp();
  registerMediaProtocol();
  registerIpcHandlers();
  // Non-blocking startup backfill for books added before cover support
  backfillMissingCovers(getLibraryDb()).catch(() => {});
  const win = createWindow();
  attachContextMenu(win);

  // Resume any shadow-library builds that were paused or interrupted (crash /
  // force-quit) before the app was last closed. Runs in the background.
  win.webContents.once("did-finish-load", () => {
    resumeInterruptedShadowBuilds(win.webContents).catch((err) => {
      console.error("[main] Shadow build resume failed:", err);
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const w = createWindow();
      attachContextMenu(w);
    }
  });
});

app.on("before-quit", () => {
  cleanupPlayerTemp();
  stopPodcastScheduler();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
