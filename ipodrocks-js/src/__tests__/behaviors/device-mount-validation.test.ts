/**
 * @vitest-environment node
 *
 * Behavioral coverage for device mount-path validation, driven through the
 * real `device:add` IPC handler (which calls DevicesCore.addDevice →
 * sanitizeMountPath). Guards against a device being pointed at a filesystem
 * root, where mirror sync's "remove extras" pass could sweep the whole disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  installElectronMock,
  setupIpcSession,
  type IpcSession,
} from "../harness/ipc-harness";
import { canRunDbTests, createFakeDevice, type FakeDevice } from "../harness";

installElectronMock();

vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
  isDeviceOnline: vi.fn().mockReturnValue(true),
  deviceRowToOnlineInput: vi.fn((row) => row),
}));
// Keep tests off the real USB backends — they would spawn ioreg/PowerShell.
vi.mock("../../main/devices/usb-devices", () => ({
  refreshUsbSnapshot: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  getUsbSnapshot: vi.fn().mockReturnValue({ available: false, devices: [] }),
  listUsbDevices: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  normalizeUsbId: vi.fn((v) => (v == null || v === "" ? null : String(v).toLowerCase().padStart(4, "0"))),
  usbDeviceMatches: vi.fn().mockReturnValue(false),
}));

const itDb = it.skipIf(!canRunDbTests);

describe("device mount-path validation", () => {
  let session: IpcSession;
  let userDataDir: string;
  let device: FakeDevice;

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!canRunDbTests) return;
    const root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-test-"));
    userDataDir = path.join(root, "userdata");
    fs.mkdirSync(path.join(userDataDir, "userData"), { recursive: true });
    device = createFakeDevice(root);
    session = await setupIpcSession({ userDataDir });
  });

  afterEach(() => {
    session?.cleanup();
    try {
      fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("accepts a normal mount path", async () => {
    const res = await session.invoke<{ id: number } | { error: string }>(
      "device:add",
      { name: "GoodDevice", mountPath: device.mountPath }
    );
    expect("id" in res && res.id).toBeGreaterThan(0);
  });

  // POSIX only: `/` is never a real device mount and must be rejected. On
  // Windows a drive root IS a legitimate iPod mount (issue #98), covered below.
  it.skipIf(!canRunDbTests || process.platform === "win32")(
    "rejects a POSIX filesystem root as the mount path",
    async () => {
      const root = path.parse(device.mountPath).root;
      const res = await session.invoke<{ error?: string }>("device:add", {
        name: "RootDevice",
        mountPath: root,
      });
      expect(res.error).toMatch(/root/i);
    }
  );

  // Regression (issue #98): a Windows drive root (e.g. E:\ / C:\) is accepted,
  // since mirror sync only deletes within the content subfolders.
  it.skipIf(!canRunDbTests || process.platform !== "win32")(
    "accepts a Windows drive root as the mount path",
    async () => {
      const root = path.parse(device.mountPath).root; // e.g. "C:\\"
      const res = await session.invoke<{ id?: number; error?: string }>(
        "device:add",
        { name: "DriveRootDevice", mountPath: root }
      );
      expect(res.error).toBeUndefined();
      expect(res.id).toBeGreaterThan(0);
    }
  );

  itDb("rejects an empty mount path", async () => {
    const res = await session.invoke<{ error?: string }>("device:add", {
      name: "EmptyDevice",
      mountPath: "   ",
    });
    expect(res.error).toMatch(/empty/i);
  });
});
