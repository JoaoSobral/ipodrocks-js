/**
 * @vitest-environment node
 *
 * The electron-free boundary (`src/main/host/`).
 *
 * The guard test here is `refuses to auto-detect under VITEST`. It exists
 * because of a real incident: `detectHost()` probes for Electron with a
 * CommonJS `require("electron")`, which vitest's `vi.mock("electron")` cannot
 * intercept. The probe therefore failed under test, the Node host was selected,
 * and `getUserDataPath()` resolved the *real* application-support directory —
 * so the suite wrote 9 devices, 46 library folders and 96 tracks straight into
 * the developer's own `ipodrock.db`. Silent, and only noticed because a later
 * test complained that its fixture device already existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createNodeHost } from "../../main/host/node-host";
import { getHost, resetHost, setHost, getUserDataPath } from "../../main/host";
import * as bridge from "../../main/host/bridge";
import type { HandlerContext } from "../../main/host/bridge";

describe("host adapter — paths", () => {
  it("honours IPODROCKS_DATA_DIR, which is what keeps a test run off the real library", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-paths-"));
    const previous = process.env.IPODROCKS_DATA_DIR;
    process.env.IPODROCKS_DATA_DIR = dir;
    try {
      expect(createNodeHost().paths.userData()).toBe(path.resolve(dir));
    } finally {
      process.env.IPODROCKS_DATA_DIR = previous;
    }
  });

  it("never resolves the real user-data directory while the suite runs", () => {
    // setup.ts points IPODROCKS_DATA_DIR at a temp dir for the whole run.
    const resolved = getUserDataPath();
    const real = path.join(os.homedir(), "Library", "Application Support", "iPodRocks");
    expect(resolved).not.toBe(real);
    expect(resolved.startsWith(os.homedir() + path.sep + "Library")).toBe(false);
  });

  it("reports a version and a non-packaged build", () => {
    const paths = createNodeHost().paths;
    expect(paths.isPackaged()).toBe(false);
    expect(paths.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("host adapter — auto-detection guard", () => {
  const savedDir = process.env.IPODROCKS_DATA_DIR;

  beforeEach(() => resetHost());
  afterEach(() => {
    process.env.IPODROCKS_DATA_DIR = savedDir;
    resetHost();
  });

  it("refuses to auto-detect under VITEST with no data dir, instead of using the real one", () => {
    delete process.env.IPODROCKS_DATA_DIR;
    expect(process.env.VITEST).toBeTruthy();
    expect(() => getHost()).toThrow(/IPODROCKS_DATA_DIR/);
  });

  it("uses an explicitly registered host without probing at all", () => {
    delete process.env.IPODROCKS_DATA_DIR;
    const host = createNodeHost();
    setHost(host);
    expect(getHost()).toBe(host);
  });
});

describe("host adapter — secrets", () => {
  let dir: string;
  const savedDir = process.env.IPODROCKS_DATA_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-secrets-"));
    process.env.IPODROCKS_DATA_DIR = dir;
    delete process.env.IPODROCKS_SECRET_KEY;
  });
  afterEach(() => {
    process.env.IPODROCKS_DATA_DIR = savedDir;
  });

  it("round-trips a value and writes a 0600 key file", () => {
    const secrets = createNodeHost().secrets;
    expect(secrets.isEncryptionAvailable()).toBe(true);

    const blob = secrets.encryptString("sk-or-v1-example");
    expect(blob.toString("utf-8")).not.toContain("sk-or-v1-example");
    expect(secrets.decryptString(blob)).toBe("sk-or-v1-example");

    const keyPath = path.join(dir, "secret.key");
    expect(fs.existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  });

  it("takes the key from the environment when one is given", () => {
    process.env.IPODROCKS_SECRET_KEY = "a".repeat(64);
    try {
      const secrets = createNodeHost().secrets;
      expect(secrets.decryptString(secrets.encryptString("hello"))).toBe("hello");
      // No key file is written when the environment supplies one.
      expect(fs.existsSync(path.join(dir, "secret.key"))).toBe(false);
    } finally {
      delete process.env.IPODROCKS_SECRET_KEY;
    }
  });

  it("rejects a malformed key from the environment rather than silently generating one", () => {
    process.env.IPODROCKS_SECRET_KEY = "not-hex";
    try {
      expect(createNodeHost().secrets.isEncryptionAvailable()).toBe(false);
    } finally {
      delete process.env.IPODROCKS_SECRET_KEY;
    }
  });

  it("says so plainly when handed a blob the desktop app's safeStorage wrote", () => {
    // An Electron safeStorage blob carries no "IRS1" magic. The daemon operator
    // must be told the key needs re-entering, not handed a decrypt error.
    const foreign = Buffer.from("v10SomeChromeOSCryptBlobThatIsLongEnoughToPass", "utf-8");
    expect(() => createNodeHost().secrets.decryptString(foreign)).toThrow(
      /not written by this host/
    );
  });

  it("detects tampering with its own ciphertext", () => {
    const secrets = createNodeHost().secrets;
    const blob = secrets.encryptString("value");
    blob[blob.length - 1] ^= 0xff;
    expect(() => secrets.decryptString(blob)).toThrow();
  });
});

describe("host adapter — handler bridge", () => {
  beforeEach(() => bridge.resetBridge());
  afterEach(() => bridge.resetBridge());

  const ctx: HandlerContext = {
    sender: { send: () => {}, isDestroyed: () => false },
  };

  it("dispatches a registered channel", async () => {
    bridge.handle("library:getStats", async (_c, n: number) => ({ doubled: n * 2 }));
    const handler = bridge.getHandler("library:getStats");
    expect(handler).toBeDefined();
    await expect(handler!(ctx, 21)).resolves.toEqual({ doubled: 42 });
  });

  it("replays already-registered channels to a transport that attaches late", () => {
    bridge.handle("sync:start", async () => "a");
    bridge.handle("sync:cancel", async () => "b");

    const seen: string[] = [];
    bridge.onHandlerRegistered((channel) => seen.push(channel));
    expect(seen.sort()).toEqual(["sync:cancel", "sync:start"]);

    // ...and keeps forwarding ones registered afterwards.
    bridge.handle("device:list", async () => "c");
    expect(seen).toContain("device:list");
  });

  it("stops forwarding once a transport detaches", () => {
    const seen: string[] = [];
    const detach = bridge.onHandlerRegistered((channel) => seen.push(channel));
    bridge.handle("app:getVersion", async () => "1");
    detach();
    bridge.handle("app:checkForUpdates", async () => "2");
    expect(seen).toEqual(["app:getVersion"]);
  });

  it("replaces a handler registered twice rather than stacking them", async () => {
    bridge.handle("settings:getRatingPrefs", async () => "first");
    bridge.handle("settings:getRatingPrefs", async () => "second");
    expect(bridge.registeredChannels().filter((c) => c === "settings:getRatingPrefs")).toHaveLength(1);
    await expect(bridge.getHandler("settings:getRatingPrefs")!(ctx)).resolves.toBe("second");
  });
});
