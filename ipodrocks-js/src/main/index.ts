import { app, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";
import { registerMediaScheme, registerMediaProtocol } from "./player/media-protocol";
import { cleanupPlayerTemp } from "./player/player-source";

registerMediaScheme();

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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  cleanupPlayerTemp();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
