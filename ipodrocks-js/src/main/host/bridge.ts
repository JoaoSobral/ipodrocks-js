/**
 * The transport-neutral handler registry.
 *
 * Every `registerXHandlers()` under `src/main/ipc/` used to call
 * `ipcMain.handle` directly, which tied the whole IPC surface to Electron. They
 * now register here instead, and *transports* attach to this registry:
 * `attachElectronTransport()` forwards to `ipcMain`, and the web server's
 * dispatcher looks channels up directly.
 *
 * The two can be attached at once — that is the point. The desktop app with the
 * web server switched on in Settings serves a local window over Electron IPC
 * and a remote browser over HTTP against the *same* handlers.
 *
 * This module must never import `electron`; `attachElectronTransport` lives in
 * `electron-bridge.ts`.
 */

/** What a handler can push back to whoever called it. Structurally satisfied by
 *  Electron's `WebContents`, so handler bodies did not have to change. */
export interface HandlerSender {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

/** First argument of every handler. Electron's `IpcMainInvokeEvent` satisfies
 *  this as-is, which is why the migration was a one-line change per call site. */
export interface HandlerContext {
  readonly sender: HandlerSender;
  /** Identifies the web session that made the call; absent over Electron IPC. */
  readonly sessionId?: string;
}

// `any` matches the existing `Handler` type in ipc/common.ts: handlers take
// heterogeneous, individually-validated argument lists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BridgeHandler = (ctx: HandlerContext, ...args: any[]) => Promise<unknown>;

export type RegistryListener = (channel: string, handler: BridgeHandler) => void;

const handlers = new Map<string, BridgeHandler>();
const listeners = new Set<RegistryListener>();

/** Registers a channel handler. Replaces `ipcMain.handle`. */
export function handle(channel: string, fn: BridgeHandler): void {
  handlers.set(channel, fn);
  for (const listener of listeners) listener(channel, fn);
}

export function removeHandler(channel: string): void {
  handlers.delete(channel);
}

export function getHandler(channel: string): BridgeHandler | undefined {
  return handlers.get(channel);
}

export function registeredChannels(): string[] {
  return [...handlers.keys()];
}

/**
 * Attaches a transport. The listener is called once for every channel already
 * registered and again for each one registered afterwards, so a transport can
 * attach before or after `registerIpcHandlers()` without caring which.
 */
export function onHandlerRegistered(listener: RegistryListener): () => void {
  for (const [channel, fn] of handlers) listener(channel, fn);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops every handler and listener. Tests, and a server restart. */
export function resetBridge(): void {
  handlers.clear();
  listeners.clear();
}
