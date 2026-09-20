import { BrowserWindow, app, dialog, safeStorage, shell } from "electron";
import type {
  HostAdapter,
  HostDialogs,
  HostPaths,
  HostSecrets,
  HostShell,
  OpenFolderOptions,
  SaveFileOptions,
} from "./types";

/**
 * The desktop host.
 *
 * **This is the only module under `src/main/host/` that may import
 * `electron`**, and nothing imports it except `src/main/index.ts`. Keeping that
 * true is what lets the headless daemon load `src/main/**` under plain Node,
 * where the `electron` package is either a path string or absent entirely.
 */

class ElectronPaths implements HostPaths {
  userData(): string {
    return app.getPath("userData");
  }
  temp(): string {
    return app.getPath("temp");
  }
  music(): string {
    return app.getPath("music");
  }
  isPackaged(): boolean {
    return app.isPackaged;
  }
  version(): string {
    return app.getVersion();
  }
}

class ElectronSecrets implements HostSecrets {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
  encryptString(plainText: string): Buffer {
    return safeStorage.encryptString(plainText);
  }
  decryptString(encrypted: Buffer): string {
    return safeStorage.decryptString(encrypted);
  }
}

class ElectronShell implements HostShell {
  async openExternal(url: string): Promise<{ opened: boolean }> {
    await shell.openExternal(url);
    return { opened: true };
  }
}

class ElectronDialogs implements HostDialogs {
  readonly available = true;

  /** Parent the sheet to a window when there is one. Unparented is still a
   *  valid call, so a missing window degrades to a free-floating dialog
   *  rather than silently returning "cancelled". */
  private parent(): BrowserWindow | null {
    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  }

  async pickFolder(opts: OpenFolderOptions = {}): Promise<string | null> {
    const win = this.parent();
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      ...(opts.title ? { title: opts.title } : {}),
      defaultPath: opts.defaultPath ?? app.getPath("music"),
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  }

  async saveFile(opts: SaveFileOptions = {}): Promise<string | null> {
    const win = this.parent();
    const options: Electron.SaveDialogOptions = {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.defaultPath ? { defaultPath: opts.defaultPath } : {}),
      ...(opts.filters ? { filters: opts.filters } : {}),
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  }
}

export function createElectronHost(): HostAdapter {
  return {
    kind: "electron",
    platform: process.platform,
    paths: new ElectronPaths(),
    secrets: new ElectronSecrets(),
    shell: new ElectronShell(),
    dialogs: new ElectronDialogs(),
  };
}
