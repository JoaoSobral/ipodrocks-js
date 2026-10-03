/**
 * @vitest-environment node
 *
 * The sync side of remote-sync resilience, away from any socket:
 *
 * - **A copy that fails because the link did is retried**, and one that fails
 *   because of the file or the device is not. Before, a five-thousand-file sync
 *   over a flaky tunnel recorded every stalled transfer as a permanent error.
 * - **A device whose browser is gone for good stops the copy loop** instead of
 *   being recorded as one error per remaining file.
 * - **The worker count adapts** (AIMD) on a networked device.
 * - **Deletes are bulk.** The orphan sweep is one `rmMany` per chunk, sized from
 *   the listing already in hand, and the empty-folder cleanup climbs only from
 *   what was removed. "Delete all" swaps a local folder out instantly and
 *   deletes it in the background, and clears a remote one in chunks rather than
 *   one recursive call that had to beat the RPC timeout.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Device } from "../../main/devices/device";
import { localFs, webDeviceRoot, type DeviceFs } from "../../main/devices/fs";
import { RemoteDeviceFs } from "../../main/devices/fs/remote-device-fs";
import type { DeviceRpcTransport } from "../../main/devices/fs/device-transport";
import type { DeviceRpcVerb } from "../../shared/device-rpc";
import { copyToDevice, DeviceGoneError } from "../../main/sync/sync-executor";
import { removeEmptiedDirsOn, removeExtraTracks } from "../../main/sync/sync-core";
import { RESET_TRASH_PREFIX, resetDeviceContent } from "../../main/sync/device-reset";
import {
  AdaptiveConcurrency,
  isTransientDeviceError,
  withTransientRetry,
} from "../../main/sync/transient-retry";
import type { DeviceProfile } from "../../shared/types";
import { makeDirectoryHandle } from "../harness/fs-handle";
import { dispatchLocalRpc } from "../harness/rpc-dispatch";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-link-"));
  process.env.IPODROCKS_SYNC_RETRY_DELAYS = "5,5,5";
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.IPODROCKS_SYNC_RETRY_DELAYS;
});

function write(rel: string, content = "x"): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** A local device whose copies fail on cue. */
function flakyFs(root: string, failures: Error[], overNetwork = false): DeviceFs & { calls: number } {
  const inner = localFs(root);
  const wrapper = Object.create(inner) as DeviceFs & { calls: number };
  wrapper.calls = 0;
  Object.defineProperty(wrapper, "capabilities", {
    value: { ...inner.capabilities, overNetwork },
  });
  wrapper.copyFromLocal = async (src, dest, opts) => {
    wrapper.calls++;
    const failure = failures.shift();
    if (failure) throw failure;
    return inner.copyFromLocal(src, dest, opts);
  };
  return wrapper;
}

function linkError(code: string, message = "Transfer failed: HTTP 524"): Error {
  return Object.assign(new Error(message), { code });
}

describe("copies retry what the link broke, and only that", () => {
  it("retries a stalled transfer and gets the file there", async () => {
    const src = write("lib/Music/A/01.mp3", "abc");
    const device = path.join(tmp, "dev");
    const dfs = flakyFs(device, [linkError("ETIMEDOUT"), linkError("EIO")]);
    const statuses: string[] = [];
    let bytes = 0;

    await copyToDevice(dfs, [src], path.join(device, "Music"), {
      progressCallback: (p) => statuses.push(p.status),
      bytesCallback: (d) => (bytes += d),
    });

    expect(statuses).toEqual(["copied"]);
    expect(dfs.calls).toBe(3);
    expect(bytes).toBe(3);
  });

  it("does not retry a failure of the device itself", async () => {
    const src = write("lib/Music/A/01.mp3");
    const device = path.join(tmp, "dev");
    const dfs = flakyFs(device, [linkError("ENOSPC", "No space left")]);
    const statuses: string[] = [];

    await copyToDevice(dfs, [src], path.join(device, "Music"), {
      progressCallback: (p) => statuses.push(p.status),
    });

    expect(statuses).toEqual(["error"]);
    expect(dfs.calls).toBe(1);
  });

  it("stops the whole copy when the browser holding the device is gone", async () => {
    const srcs = [1, 2, 3, 4, 5, 6].map((n) => write(`lib/Music/A/0${n}.mp3`));
    const device = path.join(tmp, "dev");
    const gone = linkError("EDEVICEDETACHED", "The browser holding this device disconnected.");
    const dfs = flakyFs(device, Array.from({ length: 6 }, () => gone));

    await expect(
      copyToDevice(dfs, srcs, path.join(device, "Music"))
    ).rejects.toBeInstanceOf(DeviceGoneError);
    // Not one attempt per remaining file: the loop stopped starting new ones.
    expect(dfs.calls).toBeLessThanOrEqual(4);
  });

  it("classifies errors the way the retry needs", () => {
    expect(isTransientDeviceError(linkError("ETIMEDOUT"))).toBe(true);
    expect(isTransientDeviceError(linkError("EIO", "Transfer failed: fetch failed"))).toBe(true);
    // An EIO from the device itself is not the network's fault.
    expect(isTransientDeviceError(linkError("EIO", "I/O error"))).toBe(false);
    expect(isTransientDeviceError(linkError("EDEVICEDETACHED"))).toBe(false);
    expect(isTransientDeviceError(new Error("plain"))).toBe(false);
  });

  it("gives up after the last delay", async () => {
    let attempts = 0;
    await expect(
      withTransientRetry(async () => {
        attempts++;
        throw linkError("ETIMEDOUT");
      })
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(attempts).toBe(4);
  });

  it("stops waiting when the sync is cancelled", async () => {
    process.env.IPODROCKS_SYNC_RETRY_DELAYS = "10000";
    const abort = new AbortController();
    const started = Date.now();
    const run = withTransientRetry(
      async () => {
        throw linkError("ETIMEDOUT");
      },
      { signal: abort.signal }
    );
    setTimeout(() => abort.abort(), 20);
    await expect(run).rejects.toThrow(/Cancelled/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("adaptive concurrency", () => {
  it("halves on trouble, never below one, and climbs back one at a time", () => {
    const c = new AdaptiveConcurrency(4, 3);
    expect(c.limit).toBe(4);
    c.onTransientFailure();
    expect(c.limit).toBe(2);
    c.onTransientFailure();
    c.onTransientFailure();
    expect(c.limit).toBe(1);
    for (let i = 0; i < 3; i++) c.onSuccess();
    expect(c.limit).toBe(2);
    for (let i = 0; i < 30; i++) c.onSuccess();
    expect(c.limit).toBe(4);
  });

  it("is reset by a failure mid-streak", () => {
    const c = new AdaptiveConcurrency(4, 3);
    c.onTransientFailure();
    c.onSuccess();
    c.onSuccess();
    c.onTransientFailure();
    c.onSuccess();
    c.onSuccess();
    expect(c.limit).toBe(1);
  });
});

describe("the orphan sweep deletes in bulk", () => {
  it("removes in one call per chunk, sized from the listing, and reports each", async () => {
    const device = path.join(tmp, "dev");
    const paths = [1, 2, 3].map((n) => write(`dev/Music/A/B/0${n}.mp3`, "1234"));
    const inner = localFs(device);
    let rmManyCalls = 0;
    let statCalls = 0;
    const counting = Object.create(inner) as DeviceFs;
    counting.rmMany = (...args) => {
      rmManyCalls++;
      return inner.rmMany(...args);
    };
    counting.stat = (...args) => {
      statCalls++;
      return inner.stat(...args);
    };
    const removedEvents: number[] = [];

    const result = await removeExtraTracks(
      counting,
      [...paths, path.join(device, "Music", "gone.mp3")],
      (ev) => {
        if (ev.event === "remove") removedEvents.push(Number(ev.bytes));
      },
      undefined,
      () => 4
    );

    expect(result.removed).toBe(3);
    expect(result.bytesRemoved).toBe(12);
    expect(result.removedPaths).toEqual(paths);
    expect(removedEvents).toEqual([4, 4, 4]);
    expect(rmManyCalls).toBe(1);
    expect(statCalls).toBe(0);
  });

  it("removes only the folders it emptied, deepest first, and never the root", async () => {
    const device = path.join(tmp, "dev");
    const gone = write("dev/Music/Artist/Album/01.mp3");
    write("dev/Music/Artist/Other/keep.mp3");
    fs.mkdirSync(path.join(device, "Music", "Unrelated", "Empty"), { recursive: true });
    fs.unlinkSync(gone);

    await removeEmptiedDirsOn(localFs(device), [gone], path.join(device, "Music"));

    expect(fs.existsSync(path.join(device, "Music", "Artist", "Album"))).toBe(false);
    // Still holds Other/, so it answered ENOTEMPTY and stayed.
    expect(fs.existsSync(path.join(device, "Music", "Artist", "Other", "keep.mp3"))).toBe(true);
    // Not on the climb from anything removed: untouched, as before a walk.
    expect(fs.existsSync(path.join(device, "Music", "Unrelated", "Empty"))).toBe(true);
    expect(fs.existsSync(path.join(device, "Music"))).toBe(true);
  });

  it("empties a whole chain when nothing else is in it", async () => {
    const device = path.join(tmp, "dev");
    const gone = write("dev/Music/Artist/Album/Disc 1/01.mp3");
    fs.unlinkSync(gone);
    await removeEmptiedDirsOn(localFs(device), [gone], path.join(device, "Music"));
    expect(fs.readdirSync(path.join(device, "Music"))).toEqual([]);
  });
});

function remoteDevice(root: string): { device: Device; fs: RemoteDeviceFs; calls: string[] } {
  const calls: string[] = [];
  const transport: DeviceRpcTransport = {
    clockSkewMs: 0,
    rootName: "IPOD",
    writable: true,
    async call<T>(verb: DeviceRpcVerb, args: unknown[]): Promise<T> {
      calls.push(verb);
      return (await dispatchLocalRpc(makeDirectoryHandle(root), verb, args)) as T;
    },
    async pull() {},
    async push() {},
  };
  const mount = webDeviceRoot(9);
  const rfs = new RemoteDeviceFs(mount, transport);
  const device = new Device(
    { id: 9, name: "Remote", mountPath: mount, transport: "web" } as DeviceProfile,
    rfs
  );
  return { device, fs: rfs, calls };
}

describe('"Delete all" is fast on both kinds of device', () => {
  const fakeDb = { prepare: () => ({ run: () => undefined }) } as never;

  it("swaps a local folder out, rebuilds it empty, and finishes deleting in the background", async () => {
    const mount = path.join(tmp, "ipod");
    for (let i = 0; i < 20; i++) write(`ipod/Music/A${i}/01.mp3`);
    write(`ipod/${RESET_TRASH_PREFIX}123-0/stale.mp3`);
    const device = new Device({ id: 3, name: "Local", mountPath: mount } as DeviceProfile);

    const result = await resetDeviceContent(device, fakeDb, 3);

    // Immediately: an empty Music folder, ready for the copy phase.
    expect(fs.readdirSync(path.join(mount, "Music"))).toEqual([]);
    expect(result.background).toBeDefined();
    await result.background;
    // Afterwards: no trash left, including a stale one from an earlier crash.
    expect(fs.readdirSync(mount).filter((n) => n.startsWith(RESET_TRASH_PREFIX))).toEqual([]);
  });

  it("clears a remote folder in chunks, never with one recursive call over the whole library", async () => {
    const root = path.join(tmp, "browser");
    for (let i = 0; i < 30; i++) write(`browser/Music/A${i % 5}/B${i}/01.mp3`);
    const { device, calls } = remoteDevice(root);
    const logs: string[] = [];

    await resetDeviceContent(device, fakeDb, 9, {
      progressCallback: (ev) => {
        if (ev.event === "log") logs.push(String(ev.message));
      },
    });

    expect(fs.readdirSync(path.join(root, "Music"))).toEqual([]);
    expect(calls).toContain("rmMany");
    expect(logs.some((l) => /removed 30\/30 file\(s\) from Music/.test(l))).toBe(true);
    // No trash folder on a browser-held device: it has no rename to swap with.
    expect(fs.readdirSync(root).filter((n) => n.startsWith(RESET_TRASH_PREFIX))).toEqual([]);
  });

  it("does a remote orphan sweep in a handful of calls, not three per file", async () => {
    const root = path.join(tmp, "browser");
    const rels = Array.from({ length: 40 }, (_, i) => `Music/Artist/Album${i % 4}/${i}.mp3`);
    for (const rel of rels) write(`browser/${rel}`);
    const { fs: rfs, calls } = remoteDevice(root);
    const mount = webDeviceRoot(9);
    // The sweep's paths come from a listing, which fills the name cache.
    await rfs.listTree(path.join(mount, "Music"));
    calls.length = 0;

    const removed = await removeExtraTracks(
      rfs,
      rels.map((rel) => path.join(mount, ...rel.split("/")))
    );
    await removeEmptiedDirsOn(rfs, removed.removedPaths, path.join(mount, "Music"));

    expect(removed.removed).toBe(40);
    expect(fs.readdirSync(path.join(root, "Music"))).toEqual([]);
    // One rmMany for the files, one per depth level for the folders (Album*,
    // Artist) — against 120-odd round trips before.
    expect(calls.filter((c) => c === "rmMany")).toHaveLength(3);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});
