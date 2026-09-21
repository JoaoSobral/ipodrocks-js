import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "stream";
import type { RequestHandler } from "express";
import { isPushChannel } from "../shared/ipc-channels";
import type { HandlerSender } from "../main/host/bridge";

/**
 * The control plane: one WebSocket per browser tab, carrying the push channels
 * the renderer subscribes to.
 *
 * Handlers already push through `event.sender.send(channel, ...args)` — that is
 * what `HandlerContext` is for — so a session is represented here by a
 * `HandlerSender` whose `send` writes a JSON frame down the socket. Nothing in
 * `src/main/ipc/` had to learn what a WebSocket is.
 *
 * A session can outlive its socket: the browser may reconnect after a sleep,
 * and a scan started before the drop should keep reporting into the same
 * session when it comes back. So sessions are keyed by the express session id
 * and hold a *set* of sockets — a user with the app open in two tabs sees
 * progress in both, which is the behaviour they expect.
 */

export interface EventSession {
  readonly sessionId: string;
  readonly subject: string;
  sockets: Set<WebSocket>;
}

/**
 * **There is deliberately no per-session subscription set.**
 *
 * There was one: `subscribe`/`unsubscribe` wrote to it and nothing ever read
 * it, so it was state that looked like a filter and filtered nothing. Both
 * jobs it might have done are already done elsewhere, and better:
 *
 * - *Which channels may be pushed at all* is `isPushChannel()`, a closed set
 *   checked in `pushToSession` — that is the security-relevant half, and it
 *   does not depend on what a client remembered to ask for.
 * - *Which channels this client cares about* is the client's own
 *   `listeners` map in `web-transport.ts`, which drops a frame nobody
 *   registered for.
 *
 * Filtering on it here would also actively break things: `ensureSession()`
 * exists so a handler can push the moment a call starts, before the socket
 * has had a chance to send its first `subscribe` — gating on the set would
 * drop exactly those first frames, which is the bug it was added to prevent.
 * The frames are still *accepted* so an older client is not an error.
 */

const sessions = new Map<string, EventSession>();

/**
 * Frame handlers for message types this module does not own.
 *
 * The device RPC rides the same socket — a second one would need its own
 * upgrade, its own origin check and its own auth, for no gain — but
 * `device-session.ts` is the module that understands it. Registering here
 * rather than importing it keeps the dependency pointing one way.
 */
export type SocketFrameHandler = (
  frame: Record<string, unknown>,
  ctx: { sessionId: string; subject: string; socket: WebSocket }
) => void;

const frameHandlers = new Map<string, SocketFrameHandler>();

export function registerFrameHandler(
  type: string,
  handler: SocketFrameHandler
): () => void {
  frameHandlers.set(type, handler);
  return () => {
    if (frameHandlers.get(type) === handler) frameHandlers.delete(type);
  };
}

/**
 * Sends one raw frame to a session, bypassing the push-channel allowlist.
 *
 * That allowlist exists because a push channel names something the *renderer*
 * subscribes to and a server fans frames out to sessions — a client must not
 * be able to name a channel and receive another user's frames. A device RPC
 * request is the opposite direction and is addressed to one session that has
 * already proved it holds the device, so the allowlist has nothing to say
 * about it.
 *
 * Returns false when the session has no open socket, which is how the device
 * transport learns it has been detached.
 */
export function sendRawToSession(sessionId: string, frame: unknown): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const payload = JSON.stringify(frame);
  for (const ws of session.sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
        return true;
      } catch {
        // Try the next socket; a dead one is cleaned up by its close handler.
      }
    }
  }
  return false;
}

/**
 * Sends one raw frame to **one socket**, which is what an addressed request
 * needs.
 *
 * {@link sendRawToSession} picks whichever of a session's sockets is open
 * first, and a session is a *login*, not a tab — two tabs of the same browser
 * share one express session and land in one `sockets` set. Only one of them
 * holds any given device's directory handle, so a device RPC fanned out by
 * session had a coin-flip chance of reaching the tab that does not: that tab
 * answers `EDEVICEDETACHED` and the sync fails, with nothing anywhere saying
 * that a second tab was the reason.
 *
 * Returns false when the socket is gone, which is how the device transport
 * learns it has been detached — the `close` handler has already run by then.
 */
export function sendRawToSocket(socket: WebSocket, frame: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/** A frame the browser can tell apart from an RPC reply. */
interface PushFrame {
  type: "push";
  channel: string;
  args: unknown[];
}

function getOrCreate(sessionId: string, subject: string): EventSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { sessionId, subject, sockets: new Set() };
    sessions.set(sessionId, s);
  }
  return s;
}

export function getSession(sessionId: string | undefined): EventSession | null {
  return sessionId ? (sessions.get(sessionId) ?? null) : null;
}

/** True while at least one socket for this session is open. The podcast
 *  scheduler and anything else that wants to push to a browser asks this
 *  before assuming a client is there to receive it. */
export function isSessionLive(sessionId: string | undefined): boolean {
  const s = getSession(sessionId);
  if (!s) return false;
  for (const ws of s.sockets) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * The `HandlerSender` a dispatched call is given.
 *
 * Built per call rather than stored, so a handler that holds on to `sender`
 * across a reconnect still writes to whatever sockets the session has *now*.
 */
export function senderFor(sessionId: string): HandlerSender {
  return {
    send(channel: string, ...args: unknown[]): void {
      pushToSession(sessionId, channel, args);
    },
    isDestroyed(): boolean {
      return !isSessionLive(sessionId);
    },
  };
}

export function pushToSession(
  sessionId: string,
  channel: string,
  args: unknown[]
): void {
  // A handler could in principle send anything; the client may only subscribe
  // to the closed set, so an unknown channel would be silently dropped at the
  // far end. Dropping it here instead makes the mistake visible in one place.
  if (!isPushChannel(channel)) {
    console.warn(`[server] refusing to push unknown channel "${channel}"`);
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) return;
  const frame: PushFrame = { type: "push", channel, args };
  const payload = JSON.stringify(frame);
  for (const ws of session.sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(payload);
      } catch {
        // A dead socket is cleaned up by its own close handler.
      }
    }
  }
}

/** Broadcasts to every live session. Used by the Electron-side assistant
 *  triggers, which have no originating session of their own. */
export function pushToAll(channel: string, args: unknown[]): void {
  for (const sessionId of sessions.keys()) pushToSession(sessionId, channel, args);
}

export interface EventsServerOptions {
  /** Runs express-session against the upgrade request so the cookie is read
   *  with exactly the same signing key and options as an HTTP request. */
  sessionMiddleware: RequestHandler;
  /** Origins accepted on the upgrade. */
  allowedOrigins: string[];
  /** Resolves the authenticated subject, or null to reject the upgrade. */
  authenticate: (req: IncomingMessage) => Promise<string | null>;
}

export interface EventsServer {
  close(): Promise<void>;
}

type SessionedRequest = IncomingMessage & {
  sessionID?: string;
  session?: { destroy?: () => void };
};

/**
 * An `Origin` that is absent is *not* treated as same-origin.
 *
 * Browsers always send one on a WebSocket handshake, so a missing header means
 * a non-browser client — which cannot be carrying the user's cookie by
 * accident, but also has no business here. Accepting it is the usual way CSWSH
 * protection is quietly lost.
 */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  return allowed.includes(origin);
}

export function attachEventsServer(
  httpServer: HttpServer,
  opts: EventsServerOptions
): EventsServer {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/events")) return;

    if (!originAllowed(req.headers.origin, opts.allowedOrigins)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Run the session middleware so `req.sessionID` and the passport user are
    // populated before we decide anything.
    const res = {
      getHeader: () => undefined,
      setHeader: () => {},
      end: () => {},
      writeHead: () => {},
    } as unknown as Parameters<RequestHandler>[1];

    opts.sessionMiddleware(req as Parameters<RequestHandler>[0], res, () => {
      void (async () => {
        const subject = await opts.authenticate(req);
        const sessionId = (req as SessionedRequest).sessionID;
        if (!subject || !sessionId) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const session = getOrCreate(sessionId, subject);
          session.sockets.add(ws);

          ws.on("message", (raw) => {
            let msg: { type?: string; channel?: string } & Record<string, unknown>;
            try {
              msg = JSON.parse(String(raw)) as typeof msg;
            } catch {
              return;
            }
            if (
              (msg.type === "subscribe" || msg.type === "unsubscribe") &&
              typeof msg.channel === "string"
            ) {
              // Accepted and ignored — see the note on `EventSession`.
            } else if (msg.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
            } else if (typeof msg.type === "string") {
              frameHandlers.get(msg.type)?.(msg as Record<string, unknown>, {
                sessionId,
                subject,
                socket: ws,
              });
            }
          });

          ws.on("close", () => {
            session.sockets.delete(ws);
            for (const l of socketClosedListeners) l(sessionId, ws);
            // The session entry itself is kept: a reconnect within the same
            // express session must land back on the same one, or a sync
            // started before a laptop slept would report into nothing.
            if (session.sockets.size === 0) {
              scheduleSessionSweep(sessionId);
            }
          });

          ws.on("error", () => {
            session.sockets.delete(ws);
          });

          ws.send(JSON.stringify({ type: "ready", sessionId }));
        });
      })();
    });
  };

  httpServer.on("upgrade", onUpgrade);

  return {
    async close(): Promise<void> {
      httpServer.off("upgrade", onUpgrade);
      for (const session of sessions.values()) {
        for (const ws of session.sockets) {
          try {
            ws.close(1001, "server shutting down");
          } catch {
            // Already gone.
          }
        }
      }
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Drops a session that has had no socket for a while.
 *
 * Without this the map is a slow leak on a long-running daemon: every tab that
 * is ever opened leaves an entry behind. Ten minutes is long enough to cover a
 * sleep/wake or a tunnel blip and short enough that a week of use does not
 * accumulate thousands.
 */
const SESSION_GRACE_MS = 10 * 60 * 1000;
const sweepTimers = new Map<string, NodeJS.Timeout>();

function scheduleSessionSweep(sessionId: string): void {
  clearTimeout(sweepTimers.get(sessionId));
  const timer = setTimeout(() => {
    sweepTimers.delete(sessionId);
    const session = sessions.get(sessionId);
    if (session && session.sockets.size === 0) sessions.delete(sessionId);
  }, SESSION_GRACE_MS);
  // Do not hold the process open for a bookkeeping timer.
  timer.unref?.();
  sweepTimers.set(sessionId, timer);
}

/** Tests and server restart. */
/** Notified when a socket closes, so a device attached over it is released
 *  rather than left looking connected until its next RPC times out. */
type SocketClosedListener = (sessionId: string, socket: WebSocket) => void;
const socketClosedListeners = new Set<SocketClosedListener>();

export function onSocketClosed(listener: SocketClosedListener): () => void {
  socketClosedListeners.add(listener);
  return () => socketClosedListeners.delete(listener);
}

export function resetEventSessions(): void {
  for (const t of sweepTimers.values()) clearTimeout(t);
  sweepTimers.clear();
  sessions.clear();
  frameHandlers.clear();
  socketClosedListeners.clear();
}

/** Exposed so the invoke dispatcher can register a session that has no socket
 *  yet — a client may issue its first RPC before the WebSocket opens. */
export function ensureSession(sessionId: string, subject: string): EventSession {
  const session = getOrCreate(sessionId, subject);
  // A session registered from here may never get a socket at all — a client
  // that only ever POSTs, a tab whose upgrade is blocked by a proxy. Nothing
  // else schedules the sweep for those (it is armed on socket *close*), so on
  // a long-running daemon the map grew by one entry per such session and never
  // shrank. Re-arming on each invoke doubles as a keepalive.
  if (session.sockets.size === 0) scheduleSessionSweep(sessionId);
  return session;
}
