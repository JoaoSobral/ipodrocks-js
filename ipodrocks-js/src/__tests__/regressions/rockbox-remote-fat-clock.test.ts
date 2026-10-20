/**
 * @vitest-environment node
 *
 * The Rockbox database built for a browser-held device must carry the `mtime`
 * the player reads off each file.
 *
 * The build used to assume local time for every remote device ("Windows and
 * macOS keep FAT in local time"). A browser on Linux writes UTC, so every
 * entry was a zone offset out; with auto-update on, Rockbox then deleted and
 * re-added every track at boot — empty artist/album folders until the commit,
 * and "Database is not ready" when it was interrupted. Found on a real iPod:
 * 2943 deleted entries, each 7200 s ahead of its re-added twin.
 *
 * The process zone is forced off UTC so the old behaviour cannot pass by
 * accident on a UTC machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { webDeviceRoot } from "../../main/devices/fs";
import { RemoteDeviceFs } from "../../main/devices/fs/remote-device-fs";
import type { DeviceRpcTransport } from "../../main/devices/fs/device-transport";
import { clientPlatformFrom, type ClientPlatform, type DeviceRpcVerb } from "../../shared/device-rpc";
import { browserFatClock, buildDeviceTagcache } from "../../main/rockbox/tagcache-sync";
import { INDEX_FILE_NAME, decodeTagcache } from "../../main/rockbox/tagcache-build";
import { makeDirectoryHandle } from "../harness/fs-handle";
import { dispatchLocalRpc } from "../harness/rpc-dispatch";

const WEB_ROOT = webDeviceRoot(7);
/** +05:30 all year: no DST edge to land on. */
const ZONE_OFFSET_SEC = 5.5 * 3600;

let root: string;
let savedTz: string | undefined;

function remoteFs(platform: ClientPlatform | undefined): RemoteDeviceFs {
  const transport: DeviceRpcTransport = {
    clockSkewMs: 0,
    clientPlatform: platform,
    rootName: "IPOD",
    writable: true,
    async call<T>(verb: DeviceRpcVerb, args: unknown[]): Promise<T> {
      return (await dispatchLocalRpc(makeDirectoryHandle(root), verb, args)) as T;
    },
    async pull() {
      throw new Error("not used");
    },
    async push() {
      throw new Error("not used");
    },
  };
  return new RemoteDeviceFs(WEB_ROOT, transport);
}

/** Builds the database and returns the one entry's mtime with the file's real one. */
async function buildAndRead(platform: ClientPlatform | undefined): Promise<{ stored: number; actual: number }> {
  const result = await buildDeviceTagcache(
    { fs: remoteFs(platform), mountPath: WEB_ROOT },
    {
      library: {
        exact: new Map([["music/a/b/song.mp3", { trackId: 1, title: "Song", duration: 1 }]]),
        stem: new Map(),
      },
    }
  );
  expect(result).toMatchObject({ state: "built", entries: 1 });
  const rb = path.join(root, ".rockbox");
  const db = decodeTagcache(
    fs.readFileSync(path.join(rb, INDEX_FILE_NAME)),
    new Map([[4, fs.readFileSync(path.join(rb, "database_4.tcd"))]])
  );
  const actual = fs.statSync(path.join(root, "Music/A/B/song.mp3")).mtimeMs;
  return { stored: db.entries[0].mtime ?? 0, actual: Math.floor(actual / 2000) * 2 };
}

describe("the FAT clock of a browser-held device", () => {
  beforeEach(() => {
    savedTz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-remote-fat-"));
    fs.mkdirSync(path.join(root, ".rockbox"));
    fs.writeFileSync(path.join(root, ".rockbox/rockbox-info.txt"), "Version: 4.0\n");
    fs.mkdirSync(path.join(root, "Music/A/B"), { recursive: true });
    fs.writeFileSync(path.join(root, "Music/A/B/song.mp3"), Buffer.alloc(4000, 1));
    // Mid-second, away from a 2-second boundary.
    const t = new Date(Date.UTC(2026, 9, 2, 10, 0, 10, 500));
    fs.utimesSync(path.join(root, "Music/A/B/song.mp3"), t, t);
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a Linux browser's device is stamped in UTC, as Rockbox reads it", async () => {
    const { stored, actual } = await buildAndRead("linux");
    expect(stored).toBe(actual);
  });

  it("control: an unnamed OS keeps the local-time assumption, a zone out", async () => {
    const { stored, actual } = await buildAndRead(undefined);
    expect(stored - actual).toBe(ZONE_OFFSET_SEC);
  });

  it("maps each OS to its FAT convention", () => {
    expect(browserFatClock("linux")).toEqual({ kind: "utc" });
    expect(browserFatClock("darwin")).toEqual({ kind: "local" });
    expect(browserFatClock("win32")).toEqual({ kind: "local" });
    expect(browserFatClock(undefined)).toEqual({ kind: "local" });
  });

  it("reads the OS from what the browser reports", () => {
    expect(clientPlatformFrom({ platform: "Linux x86_64" })).toBe("linux");
    expect(clientPlatformFrom({ userAgentData: { platform: "Linux" }, platform: "" })).toBe("linux");
    expect(clientPlatformFrom({ platform: "MacIntel" })).toBe("darwin");
    expect(clientPlatformFrom({ userAgentData: { platform: "Windows" } })).toBe("win32");
    // userAgentData wins over the frozen legacy field.
    expect(clientPlatformFrom({ userAgentData: { platform: "Android" }, platform: "Linux armv8l" })).toBeUndefined();
    expect(clientPlatformFrom({ userAgentData: { platform: "Chrome OS" } })).toBeUndefined();
    expect(clientPlatformFrom({})).toBeUndefined();
  });
});
