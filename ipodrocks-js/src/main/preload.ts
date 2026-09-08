import { contextBridge, ipcRenderer } from "electron";

const ALLOWED_CHANNEL_PREFIXES = [
  "dialog:",
  "library:",
  "activity:",
  "scan:",
  "app:",
  "shadow:",
  "device:",
  "genius:",
  "sync:",
  "playlist:",
  "savant:",
  "assistant:",
  "settings:",
  "harmonic:",
  "ratings:",
  "player:",
  "podcast:",
  "audiobook:",
  "maintenance:",
];

function isAllowedChannel(channel: string): boolean {
  return ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p));
}

const api = {
  /**
   * The host platform, so the renderer can hide controls that only exist on
   * some OSes (the device Eject button). A cloned primitive — it exposes no
   * capability the renderer did not already have.
   */
  platform: process.platform as NodeJS.Platform,

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isAllowedChannel(channel)) {
      return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    if (!isAllowedChannel(channel)) {
      console.warn(`Channel not allowed: ${channel}`);
      return () => {};
    }
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(...args);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld("api", api);
