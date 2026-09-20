/**
 * @vitest-environment node
 *
 * A browser-held device reports its mtimes from the *user's* clock, and the
 * sync compares them against the server's. Nothing keeps two machines in
 * agreement, and the comparison's whole tolerance is 2.5 seconds.
 *
 * The consequence of getting it wrong is not an error anywhere — it is a sync
 * that copies the entire library, every single run, for ever. A user on a
 * laptop whose clock is a minute out would see a "sync" that never converges
 * and never says why.
 *
 * So `RemoteDeviceFs` measures `clientNow - serverNow` when the browser
 * attaches and shifts every mtime it reports into server time. These tests pin
 * the correction at the level it matters: the comparison that decides whether
 * a track gets sent again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { RemoteDeviceFs } from "../../main/devices/fs/remote-device-fs";
import type { DeviceRpcTransport } from "../../main/devices/fs/device-transport";
import { webDeviceRoot } from "../../main/devices/fs";
import {
  compareLibraries,
  MTIME_TOLERANCE_MS,
} from "../../main/sync/name-size-sync";
import { makeDirectoryHandle } from "../harness/fs-handle";
import { dispatchLocalRpc } from "../harness/rpc-dispatch";

const WEB_ROOT = webDeviceRoot(9);
const MUSIC = path.join(WEB_ROOT, "Music");
const HOUR_MS = 60 * 60 * 1000;

let deviceRoot: string;

function transport(clockSkewMs: number): DeviceRpcTransport {
  return {
    clockSkewMs,
    rootName: "IPOD",
    writable: true,
    async call<T>(verb, args): Promise<T> {
      return (await dispatchLocalRpc(makeDirectoryHandle(deviceRoot), verb, args)) as T;
    },
    async pull() {
      throw new Error("not used");
    },
    async push() {
      throw new Error("not used");
    },
  };
}

beforeEach(() => {
  deviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-skew-"));
  fs.mkdirSync(path.join(deviceRoot, "Music", "Artist", "Album"), { recursive: true });
  fs.writeFileSync(path.join(deviceRoot, "Music", "Artist", "Album", "01 One.mp3"), "x");
});

afterEach(() => {
  fs.rmSync(deviceRoot, { recursive: true, force: true });
});

/**
 * The device's file as the sync sees it, through a `RemoteDeviceFs` whose
 * browser's clock is `skewMs` ahead of the server's.
 */
async function deviceFilesWithSkew(
  skewMs: number
): Promise<Record<string, { file_size: number; mtime?: number }>> {
  // The browser reports the file's mtime from its own clock, so a clock that is
  // an hour fast stamps everything an hour in the future.
  const entries = await new RemoteDeviceFs(WEB_ROOT, transport(skewMs)).listTree(
    MUSIC,
    { includeDirectories: false }
  );
  const out: Record<string, { file_size: number; mtime?: number }> = {};
  for (const entry of entries) {
    out[entry.path] = { file_size: entry.size, mtime: (entry.mtimeMs ?? 0) + skewMs };
  }
  return out;
}

/** A lossy transcode: `expectedSize` is 0, so only the mtime test applies. */
function compareLossy(
  deviceFiles: Record<string, { file_size: number; mtime?: number }>,
  libMtime: number
) {
  const libPath = "/library/Artist/Album/01 One.flac";
  return compareLibraries(
    { [libPath]: "Artist/Album/01 One.mp3" },
    { [libPath]: 0 },
    MUSIC,
    deviceFiles,
    { libraryExpectedMtimes: { [libPath]: libMtime } }
  );
}

describe("a browser-held device whose clock disagrees with the server's", () => {
  it("does not re-copy the library when the browser is an hour ahead", async () => {
    const deviceFiles = await deviceFilesWithSkew(HOUR_MS);
    // The library file is older than the device copy, which is the normal
    // state after a sync: nothing to send.
    const libMtime = Date.now() - 10_000;

    const result = compareLossy(deviceFiles, libMtime);
    expect([...result.missingTracks]).toEqual([]);
    expect(result.tracksToSkip.length).toBe(1);
  });

  it("does not re-copy the library when the browser is an hour behind", async () => {
    const deviceFiles = await deviceFilesWithSkew(-HOUR_MS);
    const libMtime = Date.now() - 10_000;

    // This is the direction that actually bit: without the correction the
    // device's file reads as an hour *older* than the library's, the
    // `libMtime <= devMtime + 2500ms` test fails, and every lossy track on the
    // player is queued for re-encoding on every sync.
    const result = compareLossy(deviceFiles, libMtime);
    expect([...result.missingTracks]).toEqual([]);
    expect(result.tracksToSkip.length).toBe(1);
  });

  it("still re-copies a track the library really did change afterwards", async () => {
    const deviceFiles = await deviceFilesWithSkew(HOUR_MS);
    // Edited well after the device copy was written. The correction must not
    // flatten a genuine difference into "nothing to do".
    const libMtime = Date.now() + 10 * MTIME_TOLERANCE_MS;

    const result = compareLossy(deviceFiles, libMtime);
    expect(result.missingTracks.size).toBe(1);
  });

  it("is what the correction buys: the raw reading fails the same test", async () => {
    // The control. Same device, same library file, correction removed — the
    // sync decides the track is missing and sends it again.
    const uncorrected = await deviceFilesWithSkew(0);
    for (const key of Object.keys(uncorrected)) {
      uncorrected[key].mtime = (uncorrected[key].mtime ?? 0) - HOUR_MS;
    }
    const result = compareLossy(uncorrected, Date.now() - 10_000);
    expect(result.missingTracks.size).toBe(1);
  });
});

describe("the skew is applied to every mtime the device reports", () => {
  it("shifts a stat as well as a walk", async () => {
    const real = fs.statSync(
      path.join(deviceRoot, "Music", "Artist", "Album", "01 One.mp3")
    ).mtimeMs;

    const skewed = new RemoteDeviceFs(WEB_ROOT, transport(HOUR_MS));
    const stat = await skewed.stat(path.join(MUSIC, "Artist", "Album", "01 One.mp3"));

    // The shim reports the real mtime (floored, as `File.lastModified` is);
    // `RemoteDeviceFs` then subtracts the skew, so the server sees a time on
    // its own clock. A `stat` that skipped this while `listTree` did it would
    // be worse than neither.
    expect(stat).not.toBeNull();
    expect(stat!.mtimeMs).toBe(Math.floor(real) - HOUR_MS);
  });
});
