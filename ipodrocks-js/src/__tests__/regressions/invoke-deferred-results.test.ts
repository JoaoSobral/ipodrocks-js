/**
 * @vitest-environment node
 *
 * Regression — every remote sync longer than ~100 s "failed" with HTTP 524.
 *
 * `POST /api/invoke/:channel` held its response open until the handler
 * returned, and `sync:start` returns when the sync does. Cloudflare cuts a
 * request that has sent nothing for about a hundred seconds, so the browser
 * reported a failure for a sync that carried on happily on the server — and
 * retrying it would have started a second one.
 *
 * Now a handler is raced against a deadline and a slow one answers
 * `202 { pending }`, collected from `GET /api/invoke/result/:id`. The same
 * table keys calls on `(session, X-Request-Id)`, which is what makes a retry
 * safe: a repeated id joins the call instead of running the handler again.
 */
import * as http from "http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handle, removeHandler } from "../../main/host/bridge";
import { handleInvoke, handleInvokeResult } from "../../server/invoke-route";
import { _resetInvokeJobs } from "../../server/invoke-jobs";

let server: http.Server;
let base: string;
let runs = 0;
let release: (() => void) | null = null;

const FAST = "app:testFast";
const SLOW = "app:testSlow";

beforeEach(async () => {
  process.env.IPODROCKS_INVOKE_DEFER_MS = "50";
  runs = 0;
  _resetInvokeJobs();
  handle(FAST, async () => {
    runs++;
    return "fast";
  });
  handle(SLOW, async (_ctx, value: unknown) => {
    runs++;
    await new Promise<void>((r) => {
      release = r;
    });
    return { echoed: value };
  });

  const app = express();
  const sid: express.RequestHandler = (req, _res, next) => {
    (req as unknown as { sessionID: string }).sessionID = String(req.get("x-sid") ?? "");
    next();
  };
  app.post("/api/invoke/:channel", sid, express.json(), (req, res) => {
    void handleInvoke(req, res, { subjectFor: () => "local:tester" });
  });
  app.get("/api/invoke/result/:requestId", sid, (req, res) => {
    void handleInvokeResult(req, res);
  });
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  release?.();
  release = null;
  removeHandler(FAST);
  removeHandler(SLOW);
  delete process.env.IPODROCKS_INVOKE_DEFER_MS;
  await new Promise<void>((r) => server.close(() => r()));
});

function post(channel: string, opts: { sid: string; id?: string; args?: unknown[] }) {
  return fetch(`${base}/api/invoke/${channel}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sid": opts.sid,
      ...(opts.id ? { "X-Request-Id": opts.id } : {}),
    },
    body: JSON.stringify({ args: opts.args ?? [] }),
  });
}

function result(id: string, sid: string) {
  return fetch(`${base}/api/invoke/result/${id}`, { headers: { "x-sid": sid } });
}

describe("a slow handler does not hold its request open", () => {
  it("answers a fast handler inline, exactly as before", async () => {
    const res = await post(FAST, { sid: "a", id: "req-fast-0001" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "fast" });
  });

  it("defers a slow one and hands its outcome to the result route", async () => {
    const res = await post(SLOW, { sid: "a", id: "req-slow-0001", args: [42] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ pending: "req-slow-0001" });

    const collecting = result("req-slow-0001", "a");
    await new Promise((r) => setTimeout(r, 20));
    release!();
    const collected = await collecting;
    expect(collected.status).toBe(200);
    expect(await collected.json()).toEqual({ result: { echoed: 42 } });
  });

  it("still defers when the client sent no request id", async () => {
    const res = await post(SLOW, { sid: "a" });
    expect(res.status).toBe(202);
    const { pending } = (await res.json()) as { pending: string };
    release!();
    // No args, so `echoed` is undefined and serialises away.
    expect(await (await result(pending, "a")).json()).toEqual({ result: {} });
  });
});

describe("a request id makes a retry safe", () => {
  it("runs the handler once for a repeated id", async () => {
    await post(SLOW, { sid: "a", id: "req-retry-001", args: [1] });
    // The response was lost on a flaky link; the client sends it again.
    const again = await post(SLOW, { sid: "a", id: "req-retry-001", args: [1] });
    expect(again.status).toBe(202);
    release!();
    expect(await (await result("req-retry-001", "a")).json()).toEqual({
      result: { echoed: 1 },
    });
    expect(runs).toBe(1);
  });

  it("refuses an id reused for another channel", async () => {
    await post(FAST, { sid: "a", id: "req-reuse-001" });
    const res = await post(SLOW, { sid: "a", id: "req-reuse-001" });
    expect(res.status).toBe(409);
    expect(runs).toBe(1);
  });
});

describe("outcomes belong to the session that asked", () => {
  it("does not hand one session's result to another", async () => {
    await post(SLOW, { sid: "victim", id: "req-private-1" });
    release!();
    await result("req-private-1", "victim");

    expect((await result("req-private-1", "attacker")).status).toBe(404);
  });

  it("does not let another session join a call by reusing its id", async () => {
    await post(FAST, { sid: "victim", id: "req-shared-01" });
    const res = await post(FAST, { sid: "attacker", id: "req-shared-01" });
    expect(res.status).toBe(200);
    // Its own call: the handler ran a second time, for the second session.
    expect(runs).toBe(2);
  });

  it("answers 404 for an id that is malformed or unknown", async () => {
    expect((await result("../../etc", "a")).status).toBe(404);
    expect((await result("never-issued-1", "a")).status).toBe(404);
  });
});
