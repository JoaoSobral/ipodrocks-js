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
];

function isAllowedChannel(channel: string): boolean {
  return ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p));
}

const api = {
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
