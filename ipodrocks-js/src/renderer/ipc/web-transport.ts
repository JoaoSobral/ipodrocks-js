import { isAllowedChannel, isPushChannel } from "@shared/ipc-channels";
import type { IpcApi } from "@shared/types";

/**
 * `window.api` over HTTP and a WebSocket.
 *
 * The renderer is barely coupled to Electron — the preload exposes exactly
 * `{ platform, invoke, on, off }`, and 119 of the app's 124 `window.api`
 * references live in `ipc/api.ts`. So the whole UI crosses to the web by
 * installing an object of the same shape, and **not one line of `ipc/api.ts`
 * changes**. If you find yourself editing a call site to make web mode work,
 * the transport is the thing that is wrong.
 *
 * `invoke` is a `POST /api/invoke/:channel`; `on` is a subscription on the
 * single `/api/events` socket.
 */

export interface AuthStatus {
  authenticated: boolean;
  needsOwnerClaim: boolean;
  providers: string[];
  localEnabled: boolean;
  user: {
    provider: string;
    displayName: string | null;
    email: string | null;
    isOwner: boolean;
  } | null;
}

type Callback = (...args: unknown[]) => void;

interface PushFrame {
  type: "push";
  channel: string;
  args: unknown[];
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

class WebTransport {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Callback>>();
  /** Raw-frame subscribers. The device link rides this same socket rather than
   *  opening a second one, which would need its own upgrade, origin check and
   *  authentication for no gain. */
  private frameListeners = new Set<(frame: Record<string, unknown>) => void>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private closed = false;
  private reopenListeners = new Set<() => void>();

  /**
   * `platform` is the *server's*, not the browser's.
   *
   * The renderer only uses it to decide whether the device Eject button can
   * work, and ejecting is something the machine holding the device does. On a
   * web device (Phase 4) that is the browser's machine and the answer changes
   * again; until then the server's answer is the right one and is what the
   * desktop build reports too.
   */
  platform: NodeJS.Platform = "linux";

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isAllowedChannel(channel)) {
      throw new Error(`Channel not allowed: ${channel}`);
    }
    const res = await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The session cookie is `SameSite=Lax` and this is a same-origin POST.
      credentials: "same-origin",
      body: JSON.stringify({ args }),
    });

    if (res.status === 401) {
      // The session expired mid-use. Reloading lands on the login screen
      // rather than leaving every panel showing a generic failure.
      window.location.reload();
      throw new Error("Not authenticated");
    }

    const body = (await res.json().catch(() => null)) as
      | { result?: unknown; error?: string }
      | null;

    if (!res.ok) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    // A handler wrapped in `safe()` returns `{ error }` as a *value*, and the
    // renderer has always read it that way. Passing it straight through keeps
    // web and desktop behaviour identical, including for the call sites that
    // check for an `error` property instead of catching.
    return body?.result ?? null;
  }

  on(channel: string, callback: Callback): () => void {
    if (!isPushChannel(channel)) {
      console.warn(`Channel not subscribable: ${channel}`);
      return () => {};
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.sendSubscribe(channel);
    }
    set.add(callback);
    return () => this.off(channel, callback);
  }

  off(channel: string, callback: Callback): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) {
      this.listeners.delete(channel);
      this.send({ type: "unsubscribe", channel });
    }
  }

  /** Sends a frame the push-channel machinery knows nothing about. */
  sendFrame(frame: unknown): void {
    this.send(frame);
  }

  /** Called every time the socket opens, including after a drop. */
  onReopen(listener: () => void): () => void {
    this.reopenListeners.add(listener);
    return () => this.reopenListeners.delete(listener);
  }

  /** Subscribes to every non-push frame. Returns the unsubscribe. */
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private sendSubscribe(channel: string): void {
    this.send({ type: "subscribe", channel });
  }

  /** Resolves once the socket is open, or rejects if the first attempt fails.
   *  Later drops are handled by the reconnect loop and never reject. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${window.location.host}/api/events`);
      this.socket = socket;
      let settled = false;

      socket.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        // A reconnect gives the server a brand new socket, and with it an
        // empty device attachment table. Anything holding a device has to say
        // so again or the next sync finds the player "not connected".
        for (const listener of [...this.reopenListeners]) {
          try {
            listener();
          } catch (err) {
            console.error("[web-transport] reopen listener threw", err);
          }
        }
        // Re-subscribe: after a reconnect the server has a fresh socket with
        // no subscriptions, and a scan that is still running would otherwise
        // report into nothing for the rest of its life.
        for (const channel of this.listeners.keys()) this.sendSubscribe(channel);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("message", (event) => {
        let frame: PushFrame | { type: string };
        try {
          frame = JSON.parse(String(event.data)) as PushFrame;
        } catch {
          return;
        }
        if (frame.type !== "push") {
          // Anything that is not a renderer push belongs to another subsystem
          // — today the device RPC. Handed on raw.
          for (const listener of [...this.frameListeners]) {
            try {
              listener(frame as Record<string, unknown>);
            } catch (err) {
              console.error("[web-transport] frame listener threw", err);
            }
          }
          return;
        }
        const push = frame as PushFrame;
        const set = this.listeners.get(push.channel);
        if (!set) return;
        for (const cb of [...set]) {
          try {
            cb(...push.args);
          } catch (err) {
            console.error(`[web-transport] listener for ${push.channel} threw`, err);
          }
        }
      });

      socket.addEventListener("close", () => {
        this.socket = null;
        if (!settled) {
          settled = true;
          reject(new Error("Could not open the event socket"));
          return;
        }
        this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        // `close` always follows; handling it in one place keeps the retry
        // logic from running twice.
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Auth status failed: HTTP ${res.status}`);
  return (await res.json()) as AuthStatus;
}

export interface WebBootstrap {
  mode: "web";
  auth: AuthStatus;
  transport: WebTransport;
}

export type { WebTransport };

/**
 * The live transport, for the few things that need the socket itself rather
 * than `window.api`.
 *
 * The device link is the only one: it exchanges RPC frames, not IPC calls, and
 * `window.api`'s shape deliberately has no room for that — keeping it to
 * `{ platform, invoke, on, off }` is what let the whole UI cross to the web
 * untouched.
 */
let activeTransport: WebTransport | null = null;

export function getWebTransport(): WebTransport | null {
  return activeTransport;
}

/**
 * True when this bundle is being served over HTTP rather than loaded into an
 * Electron window.
 *
 * **The `window.api` check alone only works before bootstrap**, and that was a
 * real bug rather than a nicety. `installWebTransport()` *installs*
 * `window.api`, so from the moment the transport is up the absence test is
 * false in both worlds — and every caller outside `main.tsx` runs after that.
 * The whole browser UI quietly believed it was Electron: the Devices panel
 * offered a server mount path and a Browse button, labelled itself "Add
 * Device", skipped restoring the folders this browser had already picked, and
 * `pickFolder()` went looking for a native dialog on the server.
 *
 * `activeTransport` is the same fact with no second copy of it — it is set
 * exactly when a web transport is installed, and never in Electron.
 */
export function isWebMode(): boolean {
  if (activeTransport !== null) return true;
  if (typeof window === "undefined") return false;
  return (window as Partial<Window>).api === undefined;
}

/**
 * Installs `window.api` and returns the auth state.
 *
 * The socket is opened *before* React mounts, so a panel that subscribes in
 * its first effect does not race the handshake. When the user is not
 * authenticated there is no socket to open — the login screen renders instead,
 * and `api` is still installed so the app can be mounted after a successful
 * login without a reload.
 */
export async function installWebTransport(): Promise<WebBootstrap> {
  const transport = new WebTransport();
  // Before `window.api`, so `isWebMode()` can never observe the half-installed
  // state where the api object exists but the transport is not yet recorded.
  activeTransport = transport;
  window.api = transport as unknown as IpcApi;

  const auth = await fetchAuthStatus();
  if (auth.authenticated) {
    await transport.connect();
    // The server is the authority on its own platform; asking costs one round
    // trip at startup and keeps the Eject button honest.
    try {
      const info = (await transport.invoke("app:getVersion")) as {
        platform?: NodeJS.Platform;
      };
      if (info?.platform) transport.platform = info.platform;
    } catch {
      // Non-fatal: the default only affects one button's visibility.
    }
  }
  return { mode: "web", auth, transport };
}
