/**
 * @vitest-environment node
 *
 * Regression — one WebSocket frame took the whole server down.
 *
 * The `/api/events` listener wrapped only `JSON.parse` in a try, then read
 * `msg.type` off the result. `null` is valid JSON, so the four-byte frame
 * `null` threw a TypeError out of `ws`'s synchronous `message` emit, out of the
 * TCP `data` handler, and — with no `uncaughtException` handler anywhere —
 * terminated the daemon for every user. A registered `SocketFrameHandler` that
 * threw had the same reach.
 *
 * Driven over a real HTTP server and a real `ws` client, because the defect was
 * where the throw *went*, not the throw itself. The control is that a second
 * socket keeps being served afterwards.
 */
import * as http from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RequestHandler } from "express";

import {
  attachEventsServer,
  registerFrameHandler,
  type EventsServer,
} from "../../server/events";

const ORIGIN = "http://127.0.0.1";
let server: http.Server;
let events: EventsServer;
let url: string;
let n = 0;

beforeEach(async () => {
  server = http.createServer();
  const sessionMiddleware: RequestHandler = (req, _res, next) => {
    (req as unknown as { sessionID: string }).sessionID = `sid-${++n}`;
    next();
  };
  events = attachEventsServer(server, {
    sessionMiddleware,
    allowedOrigins: [ORIGIN],
    authenticate: async () => "local:tester",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/events`;
});

afterEach(async () => {
  await events.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function open(): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: ORIGIN });
    const queue: Record<string, unknown>[] = [];
    const waiters: ((m: Record<string, unknown>) => void)[] = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    const next = () =>
      new Promise<Record<string, unknown>>((r) => {
        const m = queue.shift();
        if (m) r(m);
        else waiters.push(r);
      });
    ws.once("error", reject);
    ws.once("open", async () => {
      const ready = await next();
      expect(ready.type).toBe("ready");
      resolve({ ws, next });
    });
  });
}

async function ping(c: Awaited<ReturnType<typeof open>>): Promise<void> {
  c.ws.send(JSON.stringify({ type: "ping" }));
  expect((await c.next()).type).toBe("pong");
}

describe("a frame can never escape its socket", () => {
  it("ignores null, primitives and arrays and keeps the socket open", async () => {
    const onUncaught = vi.fn();
    process.on("uncaughtException", onUncaught);
    try {
      const c = await open();
      for (const frame of ["null", "1", '"x"', "[]", "[null]", "true", "{"]) {
        c.ws.send(frame);
      }
      await ping(c);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
      expect(onUncaught).not.toHaveBeenCalled();
      c.ws.close();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("contains a registered handler that throws or rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUncaught = vi.fn();
    const onUnhandled = vi.fn();
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    const offThrow = registerFrameHandler("test-throws", () => {
      throw new Error("boom");
    });
    const offReject = registerFrameHandler(
      "test-rejects",
      (async () => {
        throw new Error("async boom");
      }) as unknown as Parameters<typeof registerFrameHandler>[1]
    );
    try {
      const a = await open();
      const b = await open();
      a.ws.send(JSON.stringify({ type: "test-throws" }));
      a.ws.send(JSON.stringify({ type: "test-rejects" }));
      await ping(a);
      // Control: the other socket is still being served.
      await ping(b);
      await new Promise((r) => setTimeout(r, 20));
      expect(onUncaught).not.toHaveBeenCalled();
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/test-throws.*boom/);
      a.ws.close();
      b.ws.close();
    } finally {
      offThrow();
      offReject();
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });
});
