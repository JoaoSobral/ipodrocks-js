import { contextBridge, ipcRenderer } from "electron";

const api = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args);
  },

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      callback(...args);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  send(channel: string, ...args: unknown[]): void {
    ipcRenderer.send(channel, ...args);
  },
};

contextBridge.exposeInMainWorld("api", api);
