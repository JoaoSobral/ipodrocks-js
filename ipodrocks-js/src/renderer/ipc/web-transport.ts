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
  /** True only while the daemon was started with `IPODROCKS_RESET_OWNER=1`. */
  ownerResetAvailable?: boolean;
  providers: string[];
  localEnabled: boolean;
  user: {
    id: number;
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
  seq?: number;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** ±30% on every reconnect delay, so a server restart is not met by every tab
 *  on the network at the same instant. */
const RECONNECT_JITTER = 0.3;

/** Application-level keepalive. Proxies (Cloudflare among them) close a
 *  WebSocket that carries nothing for ~100 s. */
const KEEPALIVE_MS = 25_000;
/** With a ping every 25 s answered by a pong and the server's own heartbeat,
 *  this long without *any* frame means the connection is dead even if the
 *  browser has not noticed — a half-open TCP socket after a network switch. */
const SILENCE_LIMIT_MS = 45_000;

/** Retry budget for one invoke whose request or response was lost. */
const INVOKE_RETRY_BUDGET_MS = 2 * 60 * 1000;
const INVOKE_RETRY_BASE_MS = 500;
const INVOKE_RETRY_MAX_MS = 8_000;
/** Statuses that mean "something between us and the server failed", never
 *  "the server answered". Cloudflare's 52x family included. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * What the connection banner shows.
 *
 * - `online` — the socket is up.
 * - `reconnecting` — it dropped and the reconnect loop is running.
 * - `offline` — the browser itself says there is no network.
 * - `signed-out` — the session is gone; reconnecting cannot help.
 */
export type ConnectionStatus = "online" | "reconnecting" | "offline" | "signed-out";

export interface ConnectionState {
  status: ConnectionStatus;
  /** The server is serving a different renderer bundle than this tab runs. */
  updateAvailable: boolean;
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // `randomUUID` needs a secure context; a plain-http LAN install is not one.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
  private resyncListeners = new Set<() => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private state: ConnectionState = { status: "online", updateAvailable: false };
  /** Last push sequence number seen, and the server epoch it belongs to. */
  private lastSeq: number | null = null;
  private epoch: string | null = null;
  /** The renderer build this tab was loaded with, from the first `ready`. */
  private buildId: string | null = null;
  private lastFrameAt = 0;
  private keepaliveTimer: number | null = null;
  private wakeListenersInstalled = false;
  /** Frames waiting for the socket to come back. */
  private outbox: unknown[] = [];

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

  /**
   * `POST /api/invoke/:channel`, resilient to the link in between.
   *
   * - The call carries an `X-Request-Id`. The server keys the call on it, so
   *   re-sending the *same* id after a lost response joins the call already
   *   running instead of running the handler twice — which is the only reason
   *   retrying a non-idempotent channel (`device:add`, `sync:start`) is safe.
   *   **Never retry under a new id.**
   * - A handler that outlives the server's defer deadline answers
   *   `202 { pending }`, and the outcome is long-polled from
   *   `/api/invoke/result/:id`. Nothing holds a request open long enough for a
   *   proxy to cut it (Cloudflare's 524).
   * - A network failure or a gateway status is retried with backoff for up to
   *   two minutes, waiting for the browser to come back online first.
   */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!isAllowedChannel(channel)) {
      throw new Error(`Channel not allowed: ${channel}`);
    }
    const requestId = newRequestId();
    const deadline = Date.now() + INVOKE_RETRY_BUDGET_MS;
    let attempt = 0;
    let pending = false;

    for (;;) {
      let res: Response;
      try {
        res = pending
          ? await fetch(`/api/invoke/result/${encodeURIComponent(requestId)}`, {
              credentials: "same-origin",
            })
          : await fetch(`/api/invoke/${encodeURIComponent(channel)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
              // The session cookie is `SameSite=Lax` and this is a same-origin POST.
              credentials: "same-origin",
              body: JSON.stringify({ args }),
            });
      } catch (err) {
        // `fetch` rejects only when no response arrived at all.
        if (Date.now() >= deadline) throw err;
        await this.backoff(attempt++);
        continue;
      }

      if (res.status === 401) {
        // The session expired mid-use. Say so once, in the banner, rather than
        // leaving every panel showing its own generic failure.
        this.setState({ status: "signed-out" });
        throw new Error("Not authenticated");
      }

      if (GATEWAY_STATUSES.has(res.status)) {
        if (Date.now() >= deadline) throw new Error(`HTTP ${res.status}`);
        await this.backoff(attempt++);
        continue;
      }

      if (res.status === 202) {
        // Still running on the server. The result route long-polls, so this
        // loop is not a busy wait.
        pending = true;
        attempt = 0;
        continue;
      }

      if (res.status === 404 && pending) {
        // The server no longer knows this call — it restarted, or the result
        // expired. The outcome is genuinely lost; say so rather than re-run.
        throw new Error("The server lost track of this request (it may have restarted).");
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
  }

  /** Waits before a retry: exponential, capped, and never while the browser
   *  says it is offline (bounded by the same cap, in case it is wrong). */
  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(INVOKE_RETRY_MAX_MS, INVOKE_RETRY_BASE_MS * 2 ** attempt);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      await this.waitForOnline(INVOKE_RETRY_MAX_MS);
      return;
    }
    await sleep(delay);
  }

  private waitForOnline(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        window.removeEventListener("online", done);
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(done, maxMs);
      window.addEventListener("online", done);
    });
  }

  /** The connection banner's source of truth. */
  getConnectionState(): ConnectionState {
    return this.state;
  }

  onConnectionChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Called when frames were missed and could not be replayed — the server
   * restarted, or the outage outlasted its replay buffer. Anything showing
   * live progress should re-fetch its state from a status channel.
   */
  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  private setState(patch: Partial<ConnectionState>): void {
    const next = { ...this.state, ...patch };
    // Signed out is terminal for this page: a reconnect cannot undo it.
    if (this.state.status === "signed-out") next.status = "signed-out";
    if (next.status === this.state.status && next.updateAvailable === this.state.updateAvailable) {
      return;
    }
    this.state = next;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error("[web-transport] state listener threw", err);
      }
    }
  }

  /** Test hook: drops the socket as a network failure would. */
  simulateDrop(): void {
    this.socket?.close(4000, "simulated drop");
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

  /**
   * Sends a frame the push-channel machinery knows nothing about.
   *
   * With `queue`, a frame that cannot go now is held and sent right after the
   * next reconnect (after the reopen listeners have re-attached devices, so a
   * device RPC reply lands on an attachment that is expecting it).
   */
  sendFrame(frame: unknown, opts: { queue?: boolean } = {}): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return;
    }
    if (opts.queue) {
      this.outbox.push(frame);
      // Bounded: a tab offline for an hour must not grow without limit.
      if (this.outbox.length > 1000) this.outbox.shift();
    }
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
        this.lastFrameAt = Date.now();
        this.startKeepalive();
        this.installWakeListeners();
        this.setState({ status: "online" });
        // First, before anything else can be pushed: where this tab left off.
        // The server holds live frames back until it has this, so a replay
        // can never be overtaken by a frame that happens to arrive first.
        this.send({ type: "resume", lastSeq: this.lastSeq, epoch: this.epoch });
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
        // Last: replies to device calls the server is still waiting on. The
        // re-attach above has already told it which socket they belong to.
        const queued = this.outbox.splice(0);
        for (const frame of queued) this.send(frame);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("message", (event) => {
        this.lastFrameAt = Date.now();
        let frame: PushFrame | { type: string };
        try {
          frame = JSON.parse(String(event.data)) as PushFrame;
        } catch {
          return;
        }
        if (frame.type === "ready") {
          this.onReady(frame as { epoch?: string; seq?: number; buildId?: string | null });
          return;
        }
        if (frame.type === "resync") {
          const r = frame as { epoch?: string; seq?: number };
          this.epoch = r.epoch ?? null;
          this.lastSeq = typeof r.seq === "number" ? r.seq : null;
          for (const listener of [...this.resyncListeners]) {
            try {
              listener();
            } catch (err) {
              console.error("[web-transport] resync listener threw", err);
            }
          }
          return;
        }
        if (frame.type === "pong") return;
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
        if (typeof push.seq === "number") {
          // Already seen — a replay overlapping what arrived live.
          if (this.lastSeq !== null && push.seq <= this.lastSeq) return;
          this.lastSeq = push.seq;
        }
        const set = this.listeners.get(push.channel);
        if (!set) return;
        for (const cb of [...set]) {
          try {
            cb(...push.args);
          } catch (err) {
            // The channel name is server-supplied, so it stays an *argument*
            // rather than part of the format string: `console.error` honours
            // `%s`/`%d` directives, and a channel called `%s%s%s` would
            // otherwise reformat the message around it.
            console.error("[web-transport] listener threw", push.channel, err);
          }
        }
      });

      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.stopKeepalive();
        if (!this.closed) {
          this.setState({
            status:
              typeof navigator !== "undefined" && navigator.onLine === false
                ? "offline"
                : "reconnecting",
          });
        }
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
    if (this.state.status === "signed-out") return;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    const delay = base * (1 - RECONNECT_JITTER + Math.random() * 2 * RECONNECT_JITTER);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // An upgrade refused for want of a session looks exactly like a
        // network failure from here. Every few attempts, ask: retrying forever
        // against a logged-out session is a spinner that never ends.
        if (this.reconnectAttempts % 3 === 0) {
          void fetchAuthStatus()
            .then((auth) => {
              if (!auth.authenticated) this.setState({ status: "signed-out" });
            })
            .catch(() => {});
        }
        this.scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Skips the rest of the backoff: the network just came back, or the user
   * just looked at the tab. Waiting out a 30 s delay at that moment reads as
   * "the app is broken".
   */
  reconnectNow(): void {
    if (this.closed || this.socket || this.state.status === "signed-out") return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.connect().catch(() => this.scheduleReconnect());
  }

  private installWakeListeners(): void {
    if (this.wakeListenersInstalled || typeof window === "undefined") return;
    this.wakeListenersInstalled = true;
    window.addEventListener("online", () => this.reconnectNow());
    window.addEventListener("offline", () => {
      if (!this.socket) this.setState({ status: "offline" });
    });
    window.addEventListener("focus", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.reconnectNow();
        this.checkSilence();
      }
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = window.setInterval(() => {
      this.send({ type: "ping" });
      this.checkSilence();
    }, KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) window.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /** A socket that has heard nothing for this long is dead even if the browser
   *  still says OPEN; closing it hands over to the reconnect loop. */
  private checkSilence(): void {
    if (this.socket && Date.now() - this.lastFrameAt > SILENCE_LIMIT_MS) {
      this.socket.close(4001, "silent");
    }
  }

  private onReady(frame: { epoch?: string; seq?: number; buildId?: string | null }): void {
    if (frame.buildId) {
      if (this.buildId === null) this.buildId = frame.buildId;
      else if (this.buildId !== frame.buildId) this.setState({ updateAvailable: true });
    }
    // A first connect starts counting from wherever the server is now.
    if (this.epoch === null) {
      this.epoch = frame.epoch ?? null;
      if (this.lastSeq === null && typeof frame.seq === "number") this.lastSeq = frame.seq;
    }
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
  // For e2e specs, which drive the connection the way a flaky network would.
  (window as unknown as { __ipodrocksTransport?: WebTransport }).__ipodrocksTransport =
    transport;

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
