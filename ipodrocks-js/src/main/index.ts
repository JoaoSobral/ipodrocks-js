import { app, BrowserWindow, Menu, MenuItem } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpcHandlers, getLibraryDb } from "./ipc";
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
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
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
  cleanupPlayerTemp();
  registerMediaProtocol();
  registerIpcHandlers();
  // Non-blocking startup backfill for books added before cover support
  backfillMissingCovers(getLibraryDb()).catch(() => {});
  const win = createWindow();
  attachContextMenu(win);

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
