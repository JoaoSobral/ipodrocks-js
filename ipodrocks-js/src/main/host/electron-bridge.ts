import { ipcMain } from "electron";
import { onHandlerRegistered, type BridgeHandler } from "./bridge";

/**
 * Forwards the shared handler registry to Electron's `ipcMain`.
 *
 * Along with `electron-host.ts`, one of only two modules under `src/main/host/`
 * that import `electron`. Called from `src/main/index.ts`.
 *
 * `IpcMainInvokeEvent` already satisfies `HandlerContext` structurally — it has
 * a `sender` with `send` and `isDestroyed` — so the event is passed straight
 * through and no handler body needed changing.
 */
export function attachElectronTransport(): () => void {
  const attached = new Set<string>();

  return onHandlerRegistered((channel: string, fn: BridgeHandler) => {
    // registerIpcHandlers() can run more than once in a session (the vitest
    // harness resets modules between tests); replace rather than stack.
    if (attached.has(channel)) ipcMain.removeHandler(channel);
    attached.add(channel);
    ipcMain.handle(channel, (event, ...args) => fn(event, ...args));
  });
}
