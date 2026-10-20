/**
 * @vitest-environment node
 *
 * Hybrid devices: one player reachable both from the machine running the sync
 * engine (mount path + USB) and from a browser holding its folder.
 *
 *  - Stored as `transport='local'` + `remote_enabled=1`, so nothing that reads
 *    `transport` server-side (the podcast scheduler, auto-audiobooks) changes,
 *    and the CHECK on `transport` needs no table rebuild. The column migrates in
 *    on an older database without throwing.
 *  - **A hybrid device always has a USB identity**, and cannot lose it.
 *  - Each client gets its own side: `getDeviceForCaller()` hands the desktop
 *    the real mount and `NodeDeviceFs`, a browser `webDeviceRoot(id)` and a
 *    browser-backed filesystem. A browser's sync aimed at the server's mount
 *    would be the "sync ran against the wrong filesystem" failure again.
 *  - From a browser only the server's owner switches browser use on or off,
 *    never the local side, and never removes the device; a guest is refused
 *    every way in, including through Rocksy.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installElectronMock, setupIpcSession } from "../harness/ipc-harness";
import type { IpcSession } from "../harness/ipc-harness";
import { canRunDbTests } from "../harness";
import {
  deviceAdminBlock,
  deviceConnection,
  deviceLocalityBlock,
  autoPodcastBlock,
} from "../../shared/device-locality";
import type { DeviceProfile } from "../../shared/types";

installElectronMock();

describe("the shared guards", () => {
  const hybrid = { transport: "local" as const, remoteEnabled: true };

  it("derives the connection", () => {
    expect(deviceConnection("web")).toBe("remote");
    expect(deviceConnection("local")).toBe("local");
    expect(deviceConnection(hybrid)).toBe("hybrid");
    // remoteEnabled means nothing on a device that is already remote.
    expect(deviceConnection({ transport: "web", remoteEnabled: true })).toBe("remote");
  });

  it("lets both clients operate a hybrid device", () => {
    expect(deviceLocalityBlock(hybrid, false)).toBeNull();
    expect(deviceLocalityBlock(hybrid, true)).toBeNull();
    // A plain local device is still the server's alone.
    expect(deviceLocalityBlock({ transport: "local", remoteEnabled: false }, true)).not.toBeNull();
  });

  it("lets a browser edit but not remove it; the schedule keeps working", () => {
    expect(deviceAdminBlock(hybrid, true)).toBeNull();
    expect(deviceAdminBlock(hybrid, true, "remove")).toMatch(/also plugged into the server/i);
    expect(deviceAdminBlock(hybrid, false, "remove")).toBeNull();
    expect(autoPodcastBlock(hybrid)).toBeNull();
  });
});

describe.skipIf(!canRunDbTests)("remote_enabled on an older database", () => {
  it("opens without throwing and reads every existing device as not hybrid", async () => {
    const { AppDatabase } = await import("../../main/database/database");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-hybrid-migration-"));
    try {
      const dbPath = path.join(dir, "ipodrock.db");
      const app = new AppDatabase(dbPath);
      app.initialize();
      app.close();
      const raw = new Database(dbPath);
      raw.prepare("ALTER TABLE devices DROP COLUMN remote_enabled").run();
      raw.close();

      const again = new AppDatabase(dbPath);
      expect(() => again.initialize()).not.toThrow();
      again.close();
      const check = new Database(dbPath, { readonly: true });
      const cols = (check.prepare("PRAGMA table_info(devices)").all() as { name: string }[]).map(
        (c) => c.name
      );
      check.close();
      expect(cols).toContain("remote_enabled");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!canRunDbTests)("hybrid devices over IPC", () => {
  let dir: string;
  let mount: string;
  let session: IpcSession;
  let bridge: typeof import("../../main/host/bridge");
  let identities: typeof import("../../server/auth/identities");
  let serverDb: typeof import("../../server/db");
  let common: typeof import("../../main/ipc/common");
  let fsMod: typeof import("../../main/devices/fs");
  const sender = { send: () => {}, isDestroyed: () => false };
  const OWNER = "sid-owner";
  const GUEST = "sid-guest";
  const USB = { usbVendorId: "05ac", usbProductId: "1261", usbSerial: "HYB123" };

  async function call<T = unknown>(channel: string, sessionId: string | undefined, ...args: unknown[]) {
    const handler = bridge.getHandler(channel);
    if (!handler) throw new Error(`${channel} not registered`);
    return (await handler({ sender, sessionId }, ...args)) as T;
  }

  function putSession(sid: string, identityId: number) {
    serverDb
      .getServerDb()
      .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
      .run(sid, JSON.stringify({ identityId }), Date.now() + 60_000);
  }

  async function addLocal(name: string, usb = true): Promise<DeviceProfile> {
    const res = await call<DeviceProfile & { error?: string }>("device:add", undefined, {
      name,
      mountPath: mount,
      devMode: true,
      ...(usb ? USB : {}),
    });
    expect(res.error).toBeUndefined();
    return res;
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-hybrid-"));
    fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
    mount = fs.mkdtempSync(path.join(os.homedir(), ".ipr-hybrid-mount-"));
    session = await setupIpcSession({ userDataDir: dir });
    bridge = await import("../../main/host/bridge");
    identities = await import("../../server/auth/identities");
    serverDb = await import("../../server/db");
    common = await import("../../main/ipc/common");
    fsMod = await import("../../main/devices/fs");
    const owner = identities.addIdentity({ provider: "local", subject: "owner", isOwner: true });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    putSession(OWNER, owner.id);
    putSession(GUEST, guest.id);
  });

  afterEach(() => {
    session.cleanup();
    try {
      serverDb.closeServerDb();
    } catch {
      /* ignore */
    }
    // On Windows the app database the IPC session opened stays locked until
    // the process exits, so the temp dir cannot always be removed here.
    for (const d of [dir, mount]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("the desktop opens a local device to browsers; each client then gets its own side", async () => {
    const d = await addLocal("Hybrid A");
    const res = await call<DeviceProfile>("device:setConnections", undefined, d.id, { remote: true });
    expect(res).toMatchObject({ transport: "local", remoteEnabled: true, connection: "hybrid", mountPath: mount });

    const desktop = common.getDeviceForCaller({ sender }, d.id)!;
    expect(desktop.mountPath).toBe(mount);
    expect(desktop.fs).toBeInstanceOf(fsMod.NodeDeviceFs);

    const browser = common.getDeviceForCaller({ sender, sessionId: OWNER }, d.id)!;
    expect(browser.profile.transport).toBe("web");
    expect(browser.mountPath).toBe(fsMod.webDeviceRoot(d.id));
    // No browser holds it yet: refuses rather than answering "empty".
    expect(browser.fs).toBeInstanceOf(fsMod.DetachedDeviceFs);

    // Both may operate it; only the owner owns its browser side (no owner was
    // recorded from the desktop, so it is the server owner's).
    expect(common.blockWrongLocality({ sender, sessionId: OWNER }, browser.profile)).toBeNull();
    expect(common.deviceOwnerBlock(OWNER, d.id)).toBeNull();
    expect(common.deviceOwnerBlock(GUEST, d.id)).toMatch(/owner/i);
  });

  it("refuses a hybrid device without a USB identity, and keeps the one it has", async () => {
    const bare = await addLocal("No USB", false);
    const refused = await call<{ error?: string }>("device:setConnections", undefined, bare.id, { remote: true });
    expect(refused.error).toMatch(/USB device/i);

    const d = await addLocal("Hybrid B");
    await call("device:setConnections", undefined, d.id, { remote: true });
    const cleared = await call<{ error?: string }>("device:update", undefined, d.id, {
      usbVendorId: null,
      usbProductId: null,
      usbSerial: null,
    });
    expect(cleared.error).toMatch(/must keep its USB device/i);
  });

  it("from a browser: owner only, browser side only, sets the owner, never removes", async () => {
    const d = await addLocal("Hybrid C");
    const guest = await call<{ error?: string }>("device:setConnections", GUEST, d.id, { remote: true });
    expect(guest.error).toMatch(/owner/i);
    const local = await call<{ error?: string }>("device:setConnections", OWNER, d.id, {
      local: { mountPath: "/elsewhere", ...USB },
    });
    expect(local.error).toMatch(/machine it is plugged into/i);

    const ok = await call<DeviceProfile>("device:setConnections", OWNER, d.id, { remote: true });
    expect(ok.connection).toBe("hybrid");
    const owner = common
      .getLibrary()
      .getConnection()
      .prepare("SELECT web_owner_subject AS o FROM devices WHERE id = ?")
      .get(d.id) as { o: string };
    expect(owner.o).toBe("local:owner");

    // The browser may change settings, but not the server's mount or USB.
    await call("device:update", OWNER, d.id, { name: "Renamed", mountPath: "/tmp/evil", usbSerial: "X" });
    const after = common.getDevicesCore().getDeviceById(d.id)!.profile;
    expect(after.name).toBe("Renamed");
    expect(after.mountPath).toBe(mount);
    expect(after.usbSerial).toBe("HYB123");

    const removed = await call<{ error?: string }>("device:remove", OWNER, d.id);
    expect(removed.error).toMatch(/also plugged into the server/i);

    const off = await call<DeviceProfile>("device:setConnections", OWNER, d.id, { remote: false });
    expect(off.connection).toBe("local");
  });

  it("the desktop gives a remote device a local side, and can take it away again", async () => {
    const remote = await call<DeviceProfile>("device:add", undefined, { name: "Was Remote", transport: "web" });
    expect(remote.connection).toBe("remote");
    const noUsb = await call<{ error?: string }>("device:setConnections", undefined, remote.id, {
      local: { mountPath: mount },
    });
    expect(noUsb.error).toMatch(/USB device/i);

    const hybrid = await call<DeviceProfile>("device:setConnections", undefined, remote.id, {
      local: { mountPath: mount, ...USB },
    });
    expect(hybrid).toMatchObject({ connection: "hybrid", transport: "local", mountPath: mount });

    const back = await call<DeviceProfile>("device:setConnections", undefined, remote.id, { local: null });
    expect(back).toMatchObject({ connection: "remote", transport: "web", mountPath: fsMod.webDeviceRoot(remote.id) });
  });

  it("Rocksy applies the same rules", async () => {
    const { getToolByName } = await import("../../main/assistant/tools");
    const tool = getToolByName("device_set_connections")!;
    expect(tool.kind).toBe("write-destructive");
    const d = await addLocal("Hybrid D");
    const ctx = {
      db: common.getLibrary().getConnection(),
      getDevicesCore: common.getDevicesCore,
    } as unknown as Parameters<typeof tool.run>[1];
    const refused = (await tool.run({ device_id: d.id, remote: true }, { ...ctx, sessionId: GUEST })) as {
      error?: string;
    };
    expect(refused.error).toMatch(/owner/i);
    expect(await tool.run({ device_id: d.id, remote: true }, ctx)).toMatchObject({
      ok: true,
      connection: "hybrid",
    });
  });
});
