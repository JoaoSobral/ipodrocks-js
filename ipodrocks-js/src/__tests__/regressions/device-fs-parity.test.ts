/**
 * @vitest-environment node
 *
 * `NodeDeviceFs` and `RemoteDeviceFs` must answer the same questions the same
 * way. Every pass of the sync is written once, against the interface, and the
 * desktop app is the only one of the two anyone has been running — so a
 * divergence would show up first as a remote user's library being re-copied,
 * or silently not copied, with nothing in the logs to say why.
 *
 * The remote side is driven over an in-memory transport into the *real*
 * browser-side dispatcher, which runs against a `FileSystemDirectoryHandle`
 * shim over a temp directory. That shim is the one piece of make-believe here;
 * the e2e specs run the same dispatcher against a genuine OPFS handle, which is
 * what proves the shim is honest.
 *
 * Two behaviours get their own tests because they exist only on the remote
 * side, and both are silent when wrong:
 *
 * - **NFC/NFD name resolution.** `getDirectoryHandle` matches one exact name.
 *   Asking in NFC for a folder stored as NFD creates a *second* folder, and
 *   from then on the device holds two folders for one album — at which point
 *   the runtime matcher's ambiguity guard marks the key `-1` and every rating
 *   for that album stops matching.
 * - **Clock skew.** A laptop an hour off the server re-copies the whole
 *   library on every sync without the correction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { NodeDeviceFs, localFs, webDeviceRoot } from "../../main/devices/fs";
import { RemoteDeviceFs } from "../../main/devices/fs/remote-device-fs";
import type { DeviceRpcTransport } from "../../main/devices/fs/device-transport";
import type { DeviceRpcVerb } from "../../shared/device-rpc";
import type { DeviceFs } from "../../main/devices/fs/device-fs";
import { makeDirectoryHandle } from "../harness/fs-handle";
import { dispatchLocalRpc } from "../harness/rpc-dispatch";

const WEB_ROOT = webDeviceRoot(42);

let localRoot: string;
let remoteRoot: string;

function transportFor(root: string, clockSkewMs = 0): DeviceRpcTransport {
  return {
    clockSkewMs,
    rootName: "IPOD",
    writable: true,
    async call<T>(verb: DeviceRpcVerb, args: unknown[]): Promise<T> {
      return (await dispatchLocalRpc(makeDirectoryHandle(root), verb, args)) as T;
    },
    async pull(localSrc, destRel) {
      const dest = path.join(root, ...destRel.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(localSrc, dest);
    },
    async push(srcRel, localDest) {
      fs.copyFileSync(path.join(root, ...srcRel.split("/")), localDest);
    },
  };
}

function remoteFs(clockSkewMs = 0): DeviceFs {
  return new RemoteDeviceFs(WEB_ROOT, transportFor(remoteRoot, clockSkewMs));
}

/** The same relative path, on each implementation's own root. */
function pair(rel: string): { local: string; remote: string } {
  const segments = rel.split("/").filter(Boolean);
  return {
    local: path.join(localRoot, ...segments),
    remote: path.join(WEB_ROOT, ...segments),
  };
}

/** Runs one operation against both and returns the two answers. */
async function both<T>(
  fn: (fsImpl: DeviceFs, rootFor: (rel: string) => string) => Promise<T>
): Promise<{ local: T; remote: T }> {
  const local = await fn(localFs(localRoot), (rel) => pair(rel).local);
  const remote = await fn(remoteFs(), (rel) => pair(rel).remote);
  return { local, remote };
}

function seed(root: string): void {
  fs.mkdirSync(path.join(root, "Music", "Artist", "Album"), { recursive: true });
  fs.writeFileSync(path.join(root, "Music", "Artist", "Album", "01 One.mp3"), "aaa");
  fs.writeFileSync(path.join(root, "Music", "Artist", "Album", "02 Two.mp3"), "bbbb");
  fs.writeFileSync(path.join(root, "Music", "Artist", "Album", "cover.jpg"), "jpg");
  fs.mkdirSync(path.join(root, "Music", "Empty"), { recursive: true });
}

beforeEach(() => {
  localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-parity-local-"));
  remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-parity-remote-"));
  seed(localRoot);
  seed(remoteRoot);
});

afterEach(() => {
  fs.rmSync(localRoot, { recursive: true, force: true });
  fs.rmSync(remoteRoot, { recursive: true, force: true });
});

describe("NodeDeviceFs and RemoteDeviceFs agree", () => {
  it("on what a tree holds, and on the sizes in it", async () => {
    const { local, remote } = await both(async (impl, at) => {
      const entries = await impl.listTree(at("Music"), { includeDirectories: false });
      return entries
        .map((e) => `${e.name}:${e.size}:${e.isDirectory}`)
        .sort();
    });
    expect(remote).toEqual(local);
    expect(local).toEqual([
      "01 One.mp3:3:false",
      "02 Two.mp3:4:false",
      "cover.jpg:3:false",
    ]);
  });

  it("on a directory listing, including the empty one", async () => {
    const { local, remote } = await both(async (impl, at) =>
      (await impl.readdir(at("Music"))).map((e) => `${e.name}:${e.isDirectory}`).sort()
    );
    expect(remote).toEqual(local);
    expect(local).toEqual(["Artist:true", "Empty:true"]);
  });

  it("on a stat, and on what is not there", async () => {
    const { local, remote } = await both(async (impl, at) => {
      const file = await impl.stat(at("Music/Artist/Album/01 One.mp3"));
      const dir = await impl.stat(at("Music/Artist"));
      const missing = await impl.stat(at("Music/nope.mp3"));
      return {
        size: file?.size,
        isFile: file?.isDirectory === false,
        isDir: dir?.isDirectory,
        missing,
      };
    });
    expect(remote).toEqual(local);
    expect(local).toEqual({ size: 3, isFile: true, isDir: true, missing: null });
  });

  it("on a byte range, including one that runs past the end", async () => {
    const { local, remote } = await both(async (impl, at) => {
      const head = await impl.readRange(at("Music/Artist/Album/02 Two.mp3"), 1, 2);
      const past = await impl.readRange(at("Music/Artist/Album/02 Two.mp3"), 3, 64);
      return { head: head.toString("utf-8"), past: past.toString("utf-8") };
    });
    expect(remote).toEqual(local);
    expect(local).toEqual({ head: "bb", past: "b" });
  });

  it("on a patch: the ranges change and the length does not", async () => {
    const seedBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    fs.writeFileSync(path.join(localRoot, "idx.bin"), seedBytes);
    fs.writeFileSync(path.join(remoteRoot, "idx.bin"), seedBytes);

    const { local, remote } = await both(async (impl, at) => {
      await impl.patch(at("idx.bin"), [
        { offset: 4, bytes: Buffer.from([0xaa, 0xbb]) },
        { offset: 20, bytes: Buffer.from([0x11]) },
      ]);
      return (await impl.readFile(at("idx.bin"))).toString("hex");
    });
    expect(remote).toEqual(local);
    expect(Buffer.from(local, "hex").length).toBe(32);
  });

  it("on mkdir, write, copy and delete", async () => {
    const source = path.join(os.tmpdir(), `ipr-parity-src-${Date.now()}.mp3`);
    fs.writeFileSync(source, "copied-bytes");
    try {
      const { local, remote } = await both(async (impl, at) => {
        await impl.mkdir(at("Music/New/Album"), { recursive: true });
        await impl.writeFile(at("Music/New/Album/note.txt"), Buffer.from("hi"));
        await impl.copyFromLocal(source, at("Music/New/Album/03.mp3"));
        await impl.unlink(at("Music/Artist/Album/cover.jpg"));
        await impl.rm(at("Music/Empty"), { recursive: true });
        const entries = await impl.listTree(at("Music"), { includeDirectories: true });
        return entries.map((e) => `${e.name}:${e.isDirectory}`).sort();
      });
      expect(remote).toEqual(local);
      expect(local).toContain("03.mp3:false");
      expect(local).not.toContain("cover.jpg:false");
      expect(local).not.toContain("Empty:true");
    } finally {
      fs.rmSync(source, { force: true });
    }
  });

  it("on a removal of something that is not there, with force", async () => {
    const { local, remote } = await both(async (impl, at) => {
      await impl.rm(at("Music/ghost"), { recursive: true, force: true });
      return "no throw";
    });
    expect(remote).toEqual(local);
  });

  it("except on the three things a browser cannot do", () => {
    expect(localFs(localRoot).capabilities).toEqual({
      setMtime: true,
      freeSpace: true,
      eject: true,
    });
    expect(remoteFs().capabilities).toEqual({
      setMtime: false,
      freeSpace: true,
      eject: false,
    });
  });
});

describe("RemoteDeviceFs resolves the spelling the device actually uses", () => {
  const NFC = "Björk";            // Björk, composed
  const NFD = "Björk";           // Björk, decomposed

  it("finds an NFD folder when asked in NFC, instead of creating a second one", async () => {
    fs.mkdirSync(path.join(remoteRoot, "Music", NFD, "Album"), { recursive: true });
    fs.writeFileSync(path.join(remoteRoot, "Music", NFD, "Album", "01.mp3"), "x");

    const impl = remoteFs();
    const asked = path.join(WEB_ROOT, "Music", NFC, "Album", "01.mp3");

    // The whole hazard in one assertion: ask in the other normal form and the
    // file is found, rather than reported missing and then written again under
    // a second folder.
    expect(await impl.stat(asked)).not.toBeNull();
    expect((await impl.stat(asked))!.size).toBe(1);

    // And nothing was created: still one artist folder, still spelled the
    // device's way. A second one here is the whole failure mode — two folders
    // for one album, and every rating in it stops matching.
    const artists = fs.readdirSync(path.join(remoteRoot, "Music")).filter(
      (n) => n.normalize("NFC") === NFC
    );
    expect(artists).toEqual([NFD]);
  });

  it("writes into the existing folder rather than beside it", async () => {
    fs.mkdirSync(path.join(remoteRoot, "Music", NFD), { recursive: true });

    const impl = remoteFs();
    await impl.mkdir(path.join(WEB_ROOT, "Music", NFC, "Album"), { recursive: true });

    const artists = fs.readdirSync(path.join(remoteRoot, "Music")).filter(
      (n) => n.normalize("NFC") === NFC
    );
    expect(artists).toEqual([NFD]);
    expect(fs.existsSync(path.join(remoteRoot, "Music", NFD, "Album"))).toBe(true);
  });

  it("reports names exactly as the device spells them", async () => {
    fs.mkdirSync(path.join(remoteRoot, "Music", NFD), { recursive: true });
    const names = (await remoteFs().readdir(path.join(WEB_ROOT, "Music")))
      .map((e) => e.name)
      .filter((n) => n.normalize("NFC") === NFC);
    // Folding on the way out would put the server's idea of the name into
    // `device_synced_tracks`, and the runtime matcher would then look for a
    // path the device does not have.
    expect(names).toEqual([NFD]);
  });
});

describe("RemoteDeviceFs refuses a path that is not its own", () => {
  it("rejects a local path, rather than reinterpreting it as relative", async () => {
    const impl = remoteFs();
    // Silently treating this as relative would write a library folder's
    // contents into the player's root.
    await expect(impl.readFile("/etc/hosts")).rejects.toThrow(/not on a browser-held device/);
    await expect(impl.mkdir(path.join(localRoot, "Music"))).rejects.toThrow(
      /not on a browser-held device/
    );
  });

  it("rejects another web device's path", async () => {
    const impl = new RemoteDeviceFs(webDeviceRoot(1), transportFor(remoteRoot));
    await expect(
      impl.readFile(path.join(webDeviceRoot(2), "Music", "x.mp3"))
    ).rejects.toThrow(/outside/);
  });

  it("refuses to set an mtime rather than pretending it worked", async () => {
    // A silent no-op would make every lossy transcode look stale forever.
    await expect(
      remoteFs().setMtime(
        path.join(webDeviceRoot(1), "Music", "x.mp3"),
        new Date(),
        new Date()
      )
    ).rejects.toThrow(/cannot set a file's mtime/);
  });
});

describe("NodeDeviceFs and RemoteDeviceFs stay on their own side", () => {
  it("NodeDeviceFs refuses a web device's path", async () => {
    const node = new NodeDeviceFs(WEB_ROOT);
    await expect(node.mkdir(path.join(WEB_ROOT, "Music"))).rejects.toThrow(
      /browser-held device/
    );
  });
});
