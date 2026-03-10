import { app, BrowserWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import { registerIpcHandlers } from "./ipc";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  const candidates = [
    path.join(app.getAppPath(), "resources", "icon.png"),
    path.join(__dirname, "../../../resources/icon.png"),
    path.join(process.cwd(), "resources", "icon.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
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
      sandbox: false,
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
  registerIpcHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
