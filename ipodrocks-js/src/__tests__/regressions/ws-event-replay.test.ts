/**
 * @vitest-environment node
 *
 * Regression — progress frames pushed while a tab's socket was down were lost.
 *
 * A sync or scan keeps running on the server through a dropped connection, and
 * kept pushing into a session with no open socket. The tab came back to a log
 * with a hole in it and counters that never caught up, so a sync that had
 * finished could look stuck at 80% forever.
 *
 * Push frames now carry a per-session `seq`; the session keeps a bounded replay
 * buffer; a reconnecting socket says `resume { epoch, lastSeq }` and is handed
 * what it missed — or `resync` when that history is no longer held. Driven over
 * real sockets because the defect was *which socket got which frame, in what
 * order*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pushToSession, senderFor } from "../../server/events";
import { connect, startEventsServer, type TestEventsServer } from "../harness/events-server";

let server: TestEventsServer;

beforeEach(async () => {
  server = await startEventsServer();
});

afterEach(async () => {
  await server.close();
  delete process.env.IPODROCKS_WS_PING_MS;
});

function pushes(frames: Record<string, unknown>[]): unknown[] {
  return frames.filter((f) => f.type === "push").map((f) => (f.args as unknown[])[0]);
}

describe("push frames survive a reconnect", () => {
  it("replays exactly what a resumed socket missed, in order", async () => {
    const first = await connect(server.url, { sid: "sid-a" });
    first.send({ type: "resume", lastSeq: null, epoch: null });
    pushToSession("sid-a", "sync:progress", [{ n: 1 }]);
    const seen = await first.next();
    expect(seen.seq).toBeTypeOf("number");
    const lastSeq = seen.seq as number;

    first.ws.close();
    await first.closed;

    // Pushed into a session with no socket — the case that used to drop them.
    pushToSession("sid-a", "sync:progress", [{ n: 2 }]);
    pushToSession("sid-a", "sync:progress", [{ n: 3 }]);

    const second = await connect(server.url, { sid: "sid-a" });
    // Pushed after the socket opened but before it resumed: must still come
    // *after* the replay, or the client would discard the replay as old.
    pushToSession("sid-a", "sync:progress", [{ n: 4 }]);
    second.send({ type: "resume", lastSeq, epoch: first.ready.epoch });

    expect(pushes(await second.drain(150))).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
    second.ws.close();
  });

  it("does not tell a handler its client is gone while it is only reconnecting", async () => {
    // Every handler checks `isDestroyed()` before it pushes. Answering "yes"
    // whenever no socket happened to be open dropped exactly the frames the
    // replay buffer exists to keep.
    const c = await connect(server.url, { sid: "sid-gap" });
    c.send({ type: "resume", lastSeq: null, epoch: null });
    await c.drain(30);
    const lastSeq = c.ready.seq as number;
    c.ws.close();
    await c.closed;

    const sender = senderFor("sid-gap");
    expect(sender.isDestroyed()).toBe(false);
    if (!sender.isDestroyed()) sender.send("sync:progress", { during: "outage" });

    const again = await connect(server.url, { sid: "sid-gap" });
    again.send({ type: "resume", lastSeq, epoch: c.ready.epoch });
    expect(pushes(await again.drain(150))).toEqual([{ during: "outage" }]);
    again.ws.close();

    // A session that never existed is destroyed.
    expect(senderFor("sid-never").isDestroyed()).toBe(true);
  });

  it("never replays one session's frames to another", async () => {
    const victim = await connect(server.url, { sid: "sid-victim" });
    victim.send({ type: "resume", lastSeq: null, epoch: null });
    pushToSession("sid-victim", "sync:progress", [{ secret: true }]);
    await victim.next();

    const other = await connect(server.url, { sid: "sid-other" });
    // Asking for "everything since 0" names no session; it can only ever mean
    // this socket's own.
    other.send({ type: "resume", lastSeq: 0, epoch: victim.ready.epoch });
    expect(pushes(await other.drain(150))).toEqual([]);
    victim.ws.close();
    other.ws.close();
  });

  it("answers resync for another server epoch", async () => {
    const c = await connect(server.url, { sid: "sid-epoch" });
    pushToSession("sid-epoch", "sync:progress", [{ n: 1 }]);
    c.send({ type: "resume", lastSeq: 5, epoch: "some-other-process" });
    const frames = await c.drain(150);
    expect(frames.some((f) => f.type === "resync")).toBe(true);
    c.ws.close();
  });

  it("answers resync when the history asked for is no longer held", async () => {
    const c = await connect(server.url, { sid: "sid-old" });
    c.send({ type: "resume", lastSeq: null, epoch: null });
    for (let i = 0; i < 2100; i++) pushToSession("sid-old", "sync:progress", [{ i }]);
    await c.drain(100);
    c.ws.close();
    await c.closed;

    const again = await connect(server.url, { sid: "sid-old" });
    // seq 1 fell out of the 2000-frame buffer long ago.
    again.send({ type: "resume", lastSeq: 1, epoch: c.ready.epoch });
    const frames = await again.drain(150);
    expect(frames[0]?.type).toBe("resync");
    again.ws.close();
  });

  it("survives a malformed resume", async () => {
    const onUncaught = vi.fn();
    process.on("uncaughtException", onUncaught);
    try {
      const c = await connect(server.url, { sid: "sid-bad" });
      for (const frame of [
        { type: "resume" },
        { type: "resume", lastSeq: "abc" },
        { type: "resume", lastSeq: { $gt: 0 } },
        { type: "resume", lastSeq: Number.MAX_VALUE },
        { type: "resume", lastSeq: -1, epoch: 7 },
      ]) {
        c.send(frame);
      }
      c.send({ type: "ping" });
      const frames = await c.drain(150);
      expect(frames.some((f) => f.type === "pong")).toBe(true);
      expect(onUncaught).not.toHaveBeenCalled();
      c.ws.close();
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("greets every connection with the epoch, the current seq and the build id", async () => {
    const c = await connect(server.url, { sid: "sid-hello" });
    expect(c.ready).toMatchObject({ type: "ready", buildId: "build-test" });
    expect(c.ready.epoch).toBeTypeOf("string");
    expect(c.ready.seq).toBeTypeOf("number");
    c.ws.close();
  });
});

describe("dead sockets are found by the server's heartbeat", () => {
  it("terminates a socket that stops answering pings", async () => {
    process.env.IPODROCKS_WS_PING_MS = "60";
    // A fresh server, so the interval is read with the override in place.
    await server.close();
    server = await startEventsServer();

    // `autoPong: false` is a half-open TCP connection as far as the server
    // can tell: the peer is there, and silent.
    const silent = await connect(server.url, { sid: "sid-dead", ws: { autoPong: false } });
    const alive = await connect(server.url, { sid: "sid-alive" });

    await Promise.race([
      silent.closed,
      new Promise((_r, j) => setTimeout(() => j(new Error("never terminated")), 2000)),
    ]);
    // Control: a socket that answers is left alone.
    await new Promise((r) => setTimeout(r, 300));
    expect(alive.ws.readyState).toBe(alive.ws.OPEN);
    alive.ws.close();
  });
});
