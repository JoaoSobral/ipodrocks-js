/**
 * @vitest-environment node
 *
 * Regression — a dropped socket ended every remote sync, even though the tab
 * came straight back.
 *
 * The transport registered for a browser-held device *was* its attachment, so
 * the attachment died with the socket. The tab re-attached a second later, but
 * the sync already running held the dead transport, and every call it made
 * from then on failed `EDEVICEDETACHED` against a device that was connected
 * again. Over a Cloudflare tunnel a socket drop is routine, so a long sync
 * almost never finished.
 *
 * Now a device's *link* outlives its sockets: a drop suspends it for a grace
 * period, calls wait, and a re-attach from the same identity resumes it —
 * inheriting the calls in flight when it is the same tab. Driven over real
 * sockets, with the test playing the browser.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachDeviceSessions,
  type DeviceSessions,
} from "../../server/device-session";
import {
  getDeviceTransport,
  isDeviceAttached,
  onDeviceLinkStateChange,
  type DeviceLinkState,
} from "../../main/devices/fs/device-transport";
import { connect, startEventsServer, type TestClient, type TestEventsServer } from "../harness/events-server";

const DEVICE = 7;
const OWNER = "local:owner";

let server: TestEventsServer;
let sessions: DeviceSessions;
let owner: string | null = OWNER;

beforeEach(async () => {
  process.env.IPODROCKS_DEVICE_GRACE_MS = "5000";
  server = await startEventsServer();
  owner = OWNER;
  sessions = attachDeviceSessions({
    lookupTransport: (id) =>
      id === DEVICE ? { transport: "web", webOwnerSubject: owner } : null,
  });
});

afterEach(async () => {
  sessions.close();
  await server.close();
  delete process.env.IPODROCKS_DEVICE_GRACE_MS;
});

/** A tab: connects, attaches the device, and lets the test answer its RPCs. */
async function tab(
  sid: string,
  subject = OWNER,
  opts: { resumed?: boolean } = {}
): Promise<TestClient> {
  const c = await connect(server.url, { sid, subject });
  c.send({ type: "resume", lastSeq: null, epoch: null });
  c.send({
    type: "device-attach",
    deviceId: DEVICE,
    clientNow: Date.now(),
    rootName: "IPOD",
    writable: true,
    resumed: opts.resumed === true,
  });
  return c;
}

/** The next device RPC request this tab receives. */
async function nextRpc(c: TestClient): Promise<{ id: number; verb: string; args: unknown[] }> {
  for (;;) {
    const frame = await c.next(3000);
    if (frame.type === "device-rpc") return frame as never;
    if (frame.type === "device-attach-refused") throw new Error(String(frame.reason));
  }
}

function reply(c: TestClient, id: number, value: unknown, ok = true, code?: string): void {
  c.send({ type: "device-rpc-result", id, ok, value, code, error: ok ? undefined : code });
}

async function waitAttached(): Promise<void> {
  for (let i = 0; i < 100 && !isDeviceAttached(DEVICE); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(isDeviceAttached(DEVICE)).toBe(true);
}

async function dropAndWait(c: TestClient): Promise<void> {
  c.ws.close();
  await c.closed;
  // The server runs its close handler on the next turn.
  await new Promise((r) => setTimeout(r, 30));
}

describe("a browser-held device survives its socket dropping", () => {
  it("keeps the device attached through a drop, and serves a call made meanwhile", async () => {
    const first = await tab("sid-1");
    await waitAttached();
    const transport = getDeviceTransport(DEVICE)!;

    await dropAndWait(first);
    // Still registered: the sync holding this transport must not see a detach.
    expect(isDeviceAttached(DEVICE)).toBe(true);

    const pending = transport.call("stat", ["Music"]);
    const second = await tab("sid-1");
    const rpc = await nextRpc(second);
    expect(rpc.verb).toBe("stat");
    reply(second, rpc.id, { size: 0, mtimeMs: 1, isDirectory: true });
    await expect(pending).resolves.toEqual({ size: 0, mtimeMs: 1, isDirectory: true });
    second.ws.close();
  });

  it("hands the same tab's in-flight call to its new socket instead of re-running it", async () => {
    const first = await tab("sid-2");
    await waitAttached();
    const transport = getDeviceTransport(DEVICE)!;

    const pending = transport.call("listTree", ["Music"]);
    const rpc = await nextRpc(first);
    await dropAndWait(first);

    // Same login, worker still alive: it re-announces with `resumed` and its
    // reply to the *old* request arrives over the *new* socket.
    const second = await tab("sid-2", OWNER, { resumed: true });
    await new Promise((r) => setTimeout(r, 30));
    reply(second, rpc.id, ["answered once"]);
    await expect(pending).resolves.toEqual(["answered once"]);
    // ...and it was not sent again.
    expect(await second.drain(100)).not.toContainEqual(
      expect.objectContaining({ type: "device-rpc" })
    );
    second.ws.close();
  });

  it("re-sends a call a reloaded tab can never answer — but never a rating patch", async () => {
    const first = await tab("sid-3");
    await waitAttached();
    const transport = getDeviceTransport(DEVICE)!;

    const stat = transport.call("stat", ["a"]);
    // Observed from the start: it rejects during the re-attach, before the
    // assertion below gets to it.
    const patch = transport.call("patch", ["b", []]).catch((err: unknown) => err);
    await nextRpc(first);
    await nextRpc(first);
    await dropAndWait(first);

    // A reload: new session, nothing inherited.
    const second = await tab("sid-3-reloaded");
    const retried = await nextRpc(second);
    expect(retried.verb).toBe("stat");
    reply(second, retried.id, null);
    await expect(stat).resolves.toBeNull();

    // A patch is a write into the checksum-less Rockbox index; its caller
    // leaves a failed one for the next sync. Repeating it here is not ours to do.
    expect(await patch).toMatchObject({ code: "EDEVICEDETACHED" });
    expect(await second.drain(100)).not.toContainEqual(
      expect.objectContaining({ type: "device-rpc", verb: "patch" })
    );
    second.ws.close();
  });

  it("refuses a different account picking up a suspended device, and keeps it for the owner", async () => {
    // No recorded owner: the case the ownership check admits everybody for.
    owner = null;
    const first = await tab("sid-4");
    await waitAttached();
    await dropAndWait(first);

    const intruder = await tab("sid-x", "local:intruder");
    const refused = await intruder.next();
    expect(refused).toMatchObject({ type: "device-attach-refused" });
    expect(String(refused.reason)).toMatch(/reconnecting to another account/);

    // The load-bearing half: the owner still gets it back.
    const pending = getDeviceTransport(DEVICE)!.call("stat", ["x"]);
    const back = await tab("sid-4");
    const rpc = await nextRpc(back);
    reply(back, rpc.id, null);
    await expect(pending).resolves.toBeNull();
    intruder.ws.close();
    back.ws.close();
  });

  it("gives up when the grace runs out", async () => {
    process.env.IPODROCKS_DEVICE_GRACE_MS = "150";
    const first = await tab("sid-5");
    await waitAttached();
    const transport = getDeviceTransport(DEVICE)!;
    await dropAndWait(first);

    await expect(transport.call("stat", ["x"])).rejects.toMatchObject({
      code: "EDEVICEDETACHED",
    });
    expect(isDeviceAttached(DEVICE)).toBe(false);
  });

  it("says when it is suspended and when it is back", async () => {
    const states: DeviceLinkState[] = [];
    const off = onDeviceLinkStateChange((id, state) => {
      if (id === DEVICE) states.push(state);
    });
    try {
      const first = await tab("sid-6");
      await waitAttached();
      await dropAndWait(first);
      const second = await tab("sid-6");
      await new Promise((r) => setTimeout(r, 50));
      expect(states).toEqual(["suspended", "live"]);
      second.ws.close();
    } finally {
      off();
    }
  });
});

describe("a transfer is timed on progress, not on its total length", () => {
  it("relays progress frames to the caller", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-grace-"));
    const src = path.join(dir, "track.flac");
    fs.writeFileSync(src, Buffer.alloc(4096));
    try {
      const c = await tab("sid-7");
      await waitAttached();
      const seen: number[] = [];
      const pull = getDeviceTransport(DEVICE)!.pull(src, "Music/track.flac", {
        onProgress: (bytes) => seen.push(bytes),
      });
      const rpc = await nextRpc(c);
      expect(rpc.verb).toBe("pull");
      c.send({ type: "device-rpc-progress", id: rpc.id, bytes: 1024, total: 4096 });
      c.send({ type: "device-rpc-progress", id: rpc.id, bytes: 4096, total: 4096 });
      // Garbage is ignored, not thrown.
      c.send({ type: "device-rpc-progress", id: rpc.id, bytes: "lots", total: null });
      await new Promise((r) => setTimeout(r, 30));
      reply(c, rpc.id, null);
      await pull;
      expect(seen).toEqual([1024, 4096]);
      c.ws.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
