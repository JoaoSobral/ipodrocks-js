/**
 * @vitest-environment node
 *
 * The progress a sync reports *before* a file finishes.
 *
 * Reported from a remote sync: "0 / 2921 copied, 0%" with 110 MB transferred
 * at 4.2 MB/s. Four copies share the link, so with large files nothing lands
 * for a minute — and `copy` was the only per-file event, emitted on
 * completion. These pin the events that fill that gap: `copy_start` when a
 * worker picks a file up, per-file progress on every `bytes` frame, and a
 * `total_bytes` so the bar can follow the data instead of the file count.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localFs, type DeviceFs } from "../../main/devices/fs";
import { copyToDevice } from "../../main/sync/sync-executor";
import { copyMissingTracks, type SyncProgressPayload } from "../../main/sync/sync-core";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-inflight-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, size: number): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(size, 1));
  return p;
}

/** A device whose copies wait until released, so "in flight" can be observed. */
function gatedFs(root: string): DeviceFs & { release(): void; active: number; peak: number } {
  const inner = localFs(root);
  const wrapper = Object.create(inner) as DeviceFs & {
    release(): void;
    active: number;
    peak: number;
  };
  let gate!: () => void;
  const opened = new Promise<void>((r) => (gate = r));
  wrapper.active = 0;
  wrapper.peak = 0;
  wrapper.release = () => gate();
  wrapper.copyFromLocal = async (src, dest, opts) => {
    wrapper.active++;
    wrapper.peak = Math.max(wrapper.peak, wrapper.active);
    await opened;
    try {
      return await inner.copyFromLocal(src, dest, opts);
    } finally {
      wrapper.active--;
    }
  };
  return wrapper;
}

describe("copyToDevice reports files as they start", () => {
  it("announces each file, with its size, before it finishes", async () => {
    const srcs = [1000, 2000, 3000].map((n, i) => write(`lib/0${i}.mp3`, n));
    const device = path.join(tmp, "dev");
    const dfs = gatedFs(device);
    const order: string[] = [];
    const sizes = new Map<string, number | null>();

    const run = copyToDevice(dfs, srcs, path.join(device, "Music"), {
      startCallback: (src, size) => {
        order.push(`start ${path.basename(src)}`);
        sizes.set(src, size);
      },
      progressCallback: (p) => order.push(`done ${path.basename(p.srcPath)}`),
    });

    // Every worker has started its file; none has finished — the window the
    // modal used to have nothing to show for.
    await expect.poll(() => order.filter((o) => o.startsWith("start")).length).toBe(3);
    expect(order.some((o) => o.startsWith("done"))).toBe(false);
    expect(sizes.get(srcs[1])).toBe(2000);

    dfs.release();
    await run;
    for (const src of srcs) {
      const name = path.basename(src);
      expect(order.indexOf(`start ${name}`)).toBeLessThan(order.indexOf(`done ${name}`));
    }
  });

  it("never has more files in flight than its worker limit", async () => {
    const srcs = Array.from({ length: 10 }, (_, i) => write(`lib/${i}.mp3`, 100));
    const device = path.join(tmp, "dev");
    const dfs = gatedFs(device);
    let started = 0;

    const run = copyToDevice(dfs, srcs, path.join(device, "Music"), {
      startCallback: () => started++,
    });
    await expect.poll(() => dfs.active).toBe(4);
    expect(started).toBe(4);

    dfs.release();
    await run;
    expect(started).toBe(10);
    expect(dfs.peak).toBe(4);
  });

  it("passes each copy's own progress with the byte delta", async () => {
    const src = write("lib/one.mp3", 5000);
    const device = path.join(tmp, "dev");
    const seen: Array<[string, number, number | null]> = [];

    await copyToDevice(localFs(device), [src], path.join(device, "Music"), {
      bytesCallback: (_delta, srcPath, done, total) => seen.push([srcPath, done, total]),
    });

    expect(seen.length).toBeGreaterThan(0);
    const last = seen[seen.length - 1];
    expect(last).toEqual([src, 5000, 5000]);
  });
});

describe("copyMissingTracks", () => {
  function events(sink: SyncProgressPayload[], name: string): SyncProgressPayload[] {
    return sink.filter((e) => e.event === name);
  }

  it("announces the byte total of a direct copy before copying", async () => {
    const a = write("lib/A/01.mp3", 1234);
    const b = write("lib/A/02.mp3", 4321);
    const device = path.join(tmp, "dev");
    const sink: SyncProgressPayload[] = [];

    await copyMissingTracks(
      localFs(device),
      path.join(device, "Music"),
      "music",
      [a, b],
      { [a]: { id: 1, path: a }, [b]: { id: 2, path: b } },
      "DIRECT COPY",
      { progressCallback: (e) => sink.push(e) }
    );

    expect(events(sink, "total_bytes")).toEqual([{ event: "total_bytes", bytes: 1234 + 4321 }]);
    // Announced before any file starts, so the first bytes frame has a total.
    expect(sink.findIndex((e) => e.event === "total_bytes")).toBeLessThan(
      sink.findIndex((e) => e.event === "copy_start")
    );
    expect(events(sink, "copy_start").map((e) => e.path).sort()).toEqual([a, b].sort());
    // A bytes frame names what is in flight.
    expect(events(sink, "bytes").every((e) => Array.isArray(e.inflight))).toBe(true);
  });

  it("announces no byte total for a transcode, whose output size is unknown", async () => {
    const a = write("lib/A/01.flac", 1234);
    const device = path.join(tmp, "dev");
    const sink: SyncProgressPayload[] = [];

    // Not a real FLAC, so the encode fails — which is fine: the question is only
    // what was announced before it.
    await copyMissingTracks(
      localFs(device),
      path.join(device, "Music"),
      "music",
      [a],
      { [a]: { id: 1, path: a } },
      "mp3",
      { progressCallback: (e) => sink.push(e) }
    );

    expect(events(sink, "total_bytes")).toHaveLength(0);
    expect(events(sink, "copy_start")).toHaveLength(1);
  });
});
