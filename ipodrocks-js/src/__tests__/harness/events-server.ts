/**
 * A real `/api/events` server on a loopback port, and a real `ws` client for
 * it — for the suites whose defects live in *where* frames go across a
 * reconnect, which nothing short of real sockets can show.
 *
 * The session and identity of each connection come from headers
 * (`x-sid`, `x-subject`), so a test can reconnect as the *same* login (the
 * case a dropped tab is) or as a different one (the case an attacker is).
 *
 * Not re-exported from `harness/index.ts`: importing it pulls in `ws` and the
 * server modules, which most suites have no use for.
 */
import * as http from "http";
import { WebSocket, type ClientOptions } from "ws";
import type { RequestHandler } from "express";

import { attachEventsServer, type EventsServer } from "../../server/events";

export const TEST_ORIGIN = "http://127.0.0.1";

export interface TestEventsServer {
  url: string;
  close(): Promise<void>;
}

export async function startEventsServer(): Promise<TestEventsServer> {
  const server = http.createServer();
  const sessionMiddleware: RequestHandler = (req, _res, next) => {
    (req as unknown as { sessionID: string }).sessionID = String(
      req.headers["x-sid"] ?? "sid-default"
    );
    next();
  };
  const events: EventsServer = attachEventsServer(server, {
    sessionMiddleware,
    allowedOrigins: [TEST_ORIGIN],
    authenticate: async (req) => String(req.headers["x-subject"] ?? "local:tester"),
    buildId: () => "build-test",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/events`;
  return {
    url,
    async close() {
      await events.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface TestClient {
  ws: WebSocket;
  /** The `ready` frame this connection was greeted with. */
  ready: Record<string, unknown>;
  /** The next frame, in arrival order. */
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolves with every frame that arrives within `ms`. */
  drain(ms: number): Promise<Record<string, unknown>[]>;
  send(frame: unknown): void;
  /** Resolves when the socket has closed. */
  closed: Promise<void>;
}

export function connect(
  url: string,
  opts: { sid: string; subject?: string; ws?: ClientOptions } = { sid: "sid-default" }
): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      origin: TEST_ORIGIN,
      headers: { "x-sid": opts.sid, "x-subject": opts.subject ?? "local:tester" },
      ...opts.ws,
    });
    const queue: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    const next = (timeoutMs = 2000) =>
      new Promise<Record<string, unknown>>((r, j) => {
        const m = queue.shift();
        if (m) {
          r(m);
          return;
        }
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          j(new Error("timed out waiting for a frame"));
        }, timeoutMs);
        const waiter = (frame: Record<string, unknown>) => {
          clearTimeout(timer);
          r(frame);
        };
        waiters.push(waiter);
      });
    const drain = async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      return queue.splice(0);
    };
    const closed = new Promise<void>((r) => ws.once("close", () => r()));
    ws.once("error", reject);
    ws.once("open", async () => {
      const ready = await next();
      resolve({
        ws,
        ready,
        next,
        drain,
        send: (frame) => ws.send(JSON.stringify(frame)),
        closed,
      });
    });
  });
}
