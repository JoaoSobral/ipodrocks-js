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

  itDb("rejects a filesystem root as the mount path", async () => {
    const root = path.parse(device.mountPath).root;
    const res = await session.invoke<{ error?: string }>("device:add", {
      name: "RootDevice",
      mountPath: root,
    });
    expect(res.error).toMatch(/root/i);
  });

  itDb("rejects an empty mount path", async () => {
    const res = await session.invoke<{ error?: string }>("device:add", {
      name: "EmptyDevice",
      mountPath: "   ",
    });
    expect(res.error).toMatch(/empty/i);
  });
});
