/**
 * @vitest-environment node
 *
 * Every read and write a player receives now goes through a `DeviceFs`. On the
 * desktop that is `NodeDeviceFs`, which must be `fs` and nothing more — this
 * refactor is only safe if it changed no bytes — and in web-server mode it is a
 * folder held in someone's browser.
 *
 * Three things are pinned here, all of them the kind of mistake that is silent
 * rather than loud:
 *
 * - **`NodeDeviceFs` refuses a web device's path.** A browser-held device is
 *   given a synthetic, host-flavoured mount root, which is also a perfectly
 *   ordinary local path. A call that missed its `DeviceFs` would therefore
 *   build `/ipodrocks-web/3/Music/…` on the *server's* disk and report a
 *   successful sync for a player that received nothing.
 * - **The synthetic root stays in the host's flavour.** Forcing POSIX
 *   server-side would mean threading a path flavour through six containment
 *   guards, and missing one collapses every destination to `folder/basename` —
 *   the whole library flattens into `Music/` and the next sync sees every track
 *   as missing.
 * - **`patch()` rewrites only the ranges it is given**, leaving the file's
 *   length and every other byte alone. It is what the Rockbox index write
 *   became, and that file carries no checksum.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  NodeDeviceFs,
  isWebDevicePath,
  localFs,
  webDeviceRoot,
  WEB_DEVICE_ROOT_NAME,
} from "../../main/devices/fs";
import { containUnderFolderOn } from "../../main/sync/sync-executor";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-device-fs-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the synthetic web-device root", () => {
  it("is host-flavoured, and stable under the host's own path.resolve", () => {
    const deviceRoot = webDeviceRoot(7);

    // Whatever the separator is here, it is the one `path` uses — which is what
    // lets `containUnderFolder` and friends keep doing plain host arithmetic.
    expect(deviceRoot).toBe(path.join(path.sep, WEB_DEVICE_ROOT_NAME, "7"));
    expect(path.resolve(deviceRoot)).toBe(path.resolve(deviceRoot));

    // And a track path built under it stays inside it, which is the property
    // every containment guard depends on.
    const track = path.join(deviceRoot, "Music", "Artist", "Album", "01 Song.mp3");
    expect(path.resolve(track).startsWith(path.resolve(deviceRoot) + path.sep)).toBe(true);
  });

  it("recognises its own paths and nothing else", () => {
    expect(isWebDevicePath(webDeviceRoot(1))).toBe(true);
    expect(isWebDevicePath(path.join(webDeviceRoot(1), "Music", "a.mp3"))).toBe(true);
    expect(isWebDevicePath(path.join(root, "Music"))).toBe(false);
    expect(isWebDevicePath("")).toBe(false);
    // A folder that merely *contains* the name deeper down is a real local path.
    expect(isWebDevicePath(path.join(root, WEB_DEVICE_ROOT_NAME, "1"))).toBe(false);
  });
});

/**
 * The failure this guards against is total loss, not a wrong answer.
 *
 * Six containment guards do host `path` arithmetic on device paths.
 * `containUnderFolder` is the one that matters: if it stops recognising a
 * destination as being inside the content folder, it falls back to
 * `folder/basename` — the entire library flattens into `Music/`, the runtime
 * matcher goes ambiguous across thousands of keys, and the next sync sees every
 * track as missing. An earlier draft of the plan forced POSIX paths
 * server-side, which is exactly how that happens on Windows.
 */
describe("a web device's root is host-flavoured on both platforms", () => {
  for (const flavour of ["posix", "win32"] as const) {
    const impl = path[flavour];
    // What `webDeviceRoot` builds on a host of this flavour.
    const root = impl.join(impl.sep, WEB_DEVICE_ROOT_NAME, "3");

    it(`keeps a destination inside the content folder on ${flavour}`, () => {
      const music = impl.join(root, "Music");
      const dest = impl.join(music, "Artist", "Album", "01 Song.mp3");

      const contained = containUnderFolderOn(dest, music, "/lib/01 Song.mp3", impl);

      // Not `Music/01 Song.mp3` — the flattening fallback.
      expect(contained).toBe(impl.resolve(dest));
      expect(contained.split(impl.sep).length).toBeGreaterThan(
        impl.resolve(music).split(impl.sep).length + 1
      );
    });

    it(`still refuses an escape on ${flavour}`, () => {
      const music = impl.join(root, "Music");
      const escape = impl.join(music, "..", "..", "etc", "passwd");

      // The guard is not being weakened to make the above pass: a path that
      // really does leave the folder still collapses to the basename.
      expect(containUnderFolderOn(escape, music, "/lib/01 Song.mp3", impl)).toBe(
        impl.join(impl.resolve(music), "01 Song.mp3")
      );
    });
  }
});

describe("NodeDeviceFs refuses a browser-held device", () => {
  const deviceFs = new NodeDeviceFs(webDeviceRoot(3));
  const target = path.join(webDeviceRoot(3), "Music", "Artist", "Album", "01.mp3");

  it("throws rather than writing to the server's own filesystem", async () => {
    await expect(deviceFs.mkdir(path.dirname(target), { recursive: true })).rejects.toThrow(
      /browser-held device/
    );
    await expect(deviceFs.writeFile(target, Buffer.from("x"))).rejects.toThrow(
      /browser-held device/
    );
    await expect(deviceFs.copyFromLocal(__filename, target)).rejects.toThrow(
      /browser-held device/
    );
    await expect(deviceFs.unlink(target)).rejects.toThrow(/browser-held device/);
    await expect(deviceFs.rm(target, { recursive: true })).rejects.toThrow(
      /browser-held device/
    );
  });

  it("leaves nothing behind on the filesystem root", async () => {
    await expect(deviceFs.mkdir(path.dirname(target), { recursive: true })).rejects.toThrow();
    expect(fs.existsSync(path.resolve(webDeviceRoot(3)))).toBe(false);
  });
});

describe("NodeDeviceFs is fs and nothing more", () => {
  it("walks a tree once, with sizes and mtimes already in hand", async () => {
    const deviceFs = localFs(root);
    fs.mkdirSync(path.join(root, "Artist", "Album"), { recursive: true });
    fs.writeFileSync(path.join(root, "Artist", "Album", "01.mp3"), "aaa");
    fs.writeFileSync(path.join(root, "Artist", "Album", "cover.jpg"), "bb");
    fs.mkdirSync(path.join(root, "Empty"));

    const seen: string[] = [];
    const entries = await deviceFs.listTree(root, {
      includeDirectories: false,
      onEntry: (e) => seen.push(e.name),
    });

    expect(entries.map((e) => e.name).sort()).toEqual(["01.mp3", "cover.jpg"]);
    expect(seen.sort()).toEqual(["01.mp3", "cover.jpg"]);
    const mp3 = entries.find((e) => e.name === "01.mp3")!;
    expect(mp3.size).toBe(3);
    expect(mp3.mtimeMs).toBeGreaterThan(0);
    expect(mp3.isDirectory).toBe(false);
  });

  it("reports a missing directory as an empty walk, never a throw", async () => {
    const deviceFs = localFs(root);
    await expect(
      deviceFs.listTree(path.join(root, "not-here"))
    ).resolves.toEqual([]);
  });

  it("stops the walk on abort and returns what it had", async () => {
    const deviceFs = localFs(root);
    fs.mkdirSync(path.join(root, "A"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(root, "A", `${i}.mp3`), "x");
    }

    const controller = new AbortController();
    const entries = await deviceFs.listTree(root, {
      signal: controller.signal,
      includeDirectories: false,
      onEntry: () => controller.abort(),
    });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(5);
  });

  it("patches only the ranges it is given, and changes the file's length not at all", async () => {
    const deviceFs = localFs(root);
    const file = path.join(root, "database_idx.tcd");
    const original = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
    fs.writeFileSync(file, original);

    await deviceFs.patch(file, [
      { offset: 8, bytes: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]) },
      { offset: 40, bytes: Buffer.from([0x11]) },
    ]);

    const after = fs.readFileSync(file);
    expect(after.length).toBe(original.length);

    const changed: number[] = [];
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== after[i]) changed.push(i);
    }
    expect(changed).toEqual([8, 9, 10, 11, 40]);
  });

  it("reads back an exact byte range, and clamps at end of file", async () => {
    const deviceFs = localFs(root);
    const file = path.join(root, "bytes.bin");
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));

    expect([...(await deviceFs.readRange(file, 2, 3))]).toEqual([2, 3, 4]);
    // Asking past the end yields what is there, not padding — which is what the
    // image-header probe relies on for a file shorter than its read window.
    expect([...(await deviceFs.readRange(file, 6, 64))]).toEqual([6, 7]);
  });

  it("reports what it cannot see as null rather than throwing", async () => {
    const deviceFs = localFs(root);
    expect(await deviceFs.stat(path.join(root, "nope"))).toBeNull();
    expect(await deviceFs.exists(path.join(root, "nope"))).toBe(false);
    expect(await deviceFs.readdir(path.join(root, "nope"))).toEqual([]);
  });

  it("says a local mount can do the three things the browser cannot", () => {
    expect(localFs(root).capabilities).toEqual({
      setMtime: true,
      freeSpace: true,
      eject: true,
    });
  });
});
