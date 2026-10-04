/**
 * @vitest-environment node
 *
 * An iPod that drops off USB in the middle of a sync.
 *
 * Reported: "Disk Not Ejected Properly" on macOS, then every remaining file
 * failed — "8 / 3067 copied", 3,059 ✕ lines in two minutes, then one ✕ per
 * album from the artwork pass. An unmounted volume reads as ENOENT on every
 * call (and through a browser, `NotFoundError` → ENOENT), which the copy loop
 * treated as that file's own failure.
 *
 * Now a failure is followed by a presence probe. While the device is gone
 * nothing is recorded, nothing new starts, every worker waits on the same
 * outage, and the file that was interrupted is copied again once it is back.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localFs, type DeviceFs } from "../../main/devices/fs";
import { copyToDevice, DeviceGoneError } from "../../main/sync/sync-executor";
import { copyAlbumArtworkToDevice } from "../../main/sync/sync-core";
import { DevicePresence, DeviceUnpluggedError } from "../../main/sync/device-presence";
import {
  effectiveParallelCopies,
  sanitizeParallelCopies,
} from "../../main/devices/devices-core";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-unplug-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, size = 64): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  return p;
}

function enoent(): Error {
  return Object.assign(new Error("A requested file or directory could not be found"), {
    code: "ENOENT",
  });
}

/**
 * A device that can be unplugged. While unplugged every write fails with
 * ENOENT and `stat` answers null — exactly what an unmounted volume does.
 * `unplugAfter` pulls the cable on the Nth copy.
 */
function unpluggableFs(root: string, unplugAfter: number) {
  const inner = localFs(root);
  const dfs = Object.create(inner) as DeviceFs;
  const state = { unplugged: false, pulled: false, copies: 0, copyCalls: 0, statCalls: 0 };
  dfs.copyFromLocal = async (src, dest, opts) => {
    state.copyCalls++;
    // The cable is pulled once; after a replug the device stays.
    if (!state.pulled && state.copies === unplugAfter) {
      state.pulled = true;
      state.unplugged = true;
    }
    if (state.unplugged) throw enoent();
    state.copies++;
    return inner.copyFromLocal(src, dest, opts);
  };
  dfs.stat = async (p) => {
    state.statCalls++;
    return state.unplugged ? null : inner.stat(p);
  };
  return { dfs, state, replug: () => (state.unplugged = false) };
}

describe("an unplugged device during the copy", () => {
  it("records no errors, waits, and resumes with the interrupted file", async () => {
    const srcs = Array.from({ length: 6 }, (_, i) => write(`lib/${i}.mp3`, 100 + i));
    const device = path.join(tmp, "dev");
    const { dfs, state, replug } = unpluggableFs(device, 2);
    let waits = 0;
    let backs = 0;
    const presence = new DevicePresence(dfs, {
      pollMs: 10,
      onWaiting: () => waits++,
      onBack: () => backs++,
    });
    const statuses: string[] = [];

    const run = copyToDevice(dfs, srcs, path.join(device, "Music"), {
      presence,
      maxWorkers: 2,
      progressCallback: (p) => statuses.push(p.status),
    });

    await expect.poll(() => presence.waiting).toBe(true);
    // Nothing recorded as an error while the device is gone, and nothing new
    // started: the two workers are both waiting on the same outage.
    expect(statuses).not.toContain("error");
    const callsWhileWaiting = state.copyCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(state.copyCalls).toBe(callsWhileWaiting);

    replug();
    await run;

    expect(waits).toBe(1);
    expect(backs).toBe(1);
    expect(statuses.filter((s) => s === "copied")).toHaveLength(6);
    expect(statuses).not.toContain("error");
    for (const src of srcs) {
      expect(fs.existsSync(path.join(device, "Music", path.basename(src)))).toBe(true);
    }
  });

  it("stops once, with DeviceUnpluggedError, when the device does not come back", async () => {
    const srcs = Array.from({ length: 5 }, (_, i) => write(`lib/${i}.mp3`));
    const device = path.join(tmp, "dev");
    const { dfs, state } = unpluggableFs(device, 1);
    const presence = new DevicePresence(dfs, { pollMs: 5, timeoutMs: 40 });
    const statuses: string[] = [];

    await expect(
      copyToDevice(dfs, srcs, path.join(device, "Music"), {
        presence,
        maxWorkers: 1,
        progressCallback: (p) => statuses.push(p.status),
      })
    ).rejects.toBeInstanceOf(DeviceUnpluggedError);

    // One copied before the cable went; no error per remaining file; nothing
    // started after the give-up.
    expect(statuses).toEqual(["copied"]);
    expect(state.copyCalls).toBe(2);
  });

  it("stops quietly when the sync is cancelled during the wait", async () => {
    const srcs = Array.from({ length: 3 }, (_, i) => write(`lib/${i}.mp3`));
    const device = path.join(tmp, "dev");
    const { dfs } = unpluggableFs(device, 0);
    const controller = new AbortController();
    const presence = new DevicePresence(dfs, { pollMs: 5, signal: controller.signal });
    const statuses: string[] = [];

    const run = copyToDevice(dfs, srcs, path.join(device, "Music"), {
      presence,
      cancelSignal: controller.signal,
      maxWorkers: 1,
      progressCallback: (p) => statuses.push(p.status),
    });
    await expect.poll(() => presence.waiting).toBe(true);
    controller.abort();
    await run;
    expect(statuses).toEqual([]);
  });

  it("without a presence probe, keeps the old per-file behaviour", async () => {
    // The control: what the sync used to do, and what it still does for a
    // caller that does not opt in.
    const srcs = Array.from({ length: 3 }, (_, i) => write(`lib/${i}.mp3`));
    const device = path.join(tmp, "dev");
    const { dfs } = unpluggableFs(device, 0);
    const statuses: string[] = [];
    await copyToDevice(dfs, srcs, path.join(device, "Music"), {
      maxWorkers: 1,
      progressCallback: (p) => statuses.push(p.status),
    });
    expect(statuses).toEqual(["error", "error", "error"]);
  });

  it("still treats a closed browser tab as DeviceGoneError", async () => {
    const src = write("lib/a.mp3");
    const device = path.join(tmp, "dev");
    const inner = localFs(device);
    const dfs = Object.create(inner) as DeviceFs;
    dfs.copyFromLocal = async () => {
      throw Object.assign(new Error("detached"), { code: "EDEVICEDETACHED" });
    };
    await expect(
      copyToDevice(dfs, [src], path.join(device, "Music"), {
        presence: new DevicePresence(dfs, { pollMs: 5 }),
      })
    ).rejects.toBeInstanceOf(DeviceGoneError);
  });
});

describe("an unplugged device during the artwork pass", () => {
  it("waits and writes the cover instead of failing the album", async () => {
    // A real JPEG is not needed: the source is a folder cover.jpg, and the
    // generator is what fails while unplugged. Use an existing small image.
    const album = path.join(tmp, "lib", "Artist", "Album");
    fs.mkdirSync(album, { recursive: true });
    const track = path.join(album, "01 Song.mp3");
    fs.writeFileSync(track, Buffer.alloc(64));
    // 1x1 white JPEG.
    fs.writeFileSync(
      path.join(album, "cover.jpg"),
      Buffer.from(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
        "base64"
      )
    );

    const device = path.join(tmp, "dev");
    const content = path.join(device, "Music");
    fs.mkdirSync(content, { recursive: true });
    const inner = localFs(device);
    const dfs = Object.create(inner) as DeviceFs;
    let unplugged = true;
    const writeFile = inner.writeFile.bind(inner);
    dfs.writeFile = async (p, data) => {
      if (unplugged) throw enoent();
      return writeFile(p, data);
    };
    const copyFromLocal = inner.copyFromLocal.bind(inner);
    dfs.copyFromLocal = async (s, d, o) => {
      if (unplugged) throw enoent();
      return copyFromLocal(s, d, o);
    };
    dfs.stat = async (p) => (unplugged ? null : inner.stat(p));
    const presence = new DevicePresence(dfs, { pollMs: 5 });

    const run = copyAlbumArtworkToDevice(dfs, content, "music", { [track]: { path: track } }, {
      presence,
    });
    await expect.poll(() => presence.waiting).toBe(true);
    unplugged = false;
    const result = await run;
    expect(result.errors).toBe(0);
  });
});

describe("parallel copies setting", () => {
  it("defaults to one file at a time for a remote device, four for local", () => {
    expect(effectiveParallelCopies({ transport: "web" })).toBe(1);
    expect(effectiveParallelCopies({ transport: "local" })).toBe(4);
    expect(effectiveParallelCopies({})).toBe(4);
    expect(effectiveParallelCopies({ transport: "web", maxParallelCopies: 3 })).toBe(3);
    expect(effectiveParallelCopies({ transport: "local", maxParallelCopies: null })).toBe(4);
  });

  it("accepts 1 to 4 and null, and refuses anything else", () => {
    expect(sanitizeParallelCopies(1)).toBe(1);
    expect(sanitizeParallelCopies("4")).toBe(4);
    expect(sanitizeParallelCopies(null)).toBeNull();
    expect(sanitizeParallelCopies("")).toBeNull();
    for (const bad of [0, 5, 1.5, -1, "two", Number.NaN]) {
      expect(() => sanitizeParallelCopies(bad), String(bad)).toThrow(/1 to 4/);
    }
  });
});
