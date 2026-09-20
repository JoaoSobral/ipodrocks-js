import { contextBridge, ipcRenderer } from "electron";
import { isAllowedChannel } from "../shared/ipc-channels";

type Callback = (...args: unknown[]) => void;
type Listener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => void;

/**
 * `on` hands `ipcRenderer` a wrapper that strips the event argument, so the
 * caller's own function is never the registered listener and `off(cb)` could
 * not find it. Keyed per channel because the same callback may legitimately be
 * subscribed to two of them.
 */
const listeners = new Map<string, Map<Callback, Listener>>();

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

  on(channel: string, callback: Callback): () => void {
    if (!isAllowedChannel(channel)) {
      console.warn(`Channel not allowed: ${channel}`);
      return () => {};
    }
    const listener: Listener = (_event, ...args) => {
      callback(...args);
    };
    let perChannel = listeners.get(channel);
    if (!perChannel) {
      perChannel = new Map();
      listeners.set(channel, perChannel);
    }
    perChannel.set(callback, listener);
    ipcRenderer.on(channel, listener);
    return () => {
      perChannel.delete(callback);
      ipcRenderer.removeListener(channel, listener);
    };
  },

  /**
   * `IpcApi` has always declared this and the preload has never exposed it, so
   * `window.api.off(...)` threw `TypeError: not a function` on the desktop —
   * nothing calls it, which is why nobody noticed. Implemented rather than
   * dropped from the declaration, because the web transport needs a real one
   * and a `window.api` whose shape differs between transports is exactly the
   * kind of difference that only shows up in production.
   */
  off(channel: string, callback: Callback): void {
    const listener = listeners.get(channel)?.get(callback);
    if (!listener) return;
    listeners.get(channel)?.delete(callback);
    ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("api", api);
