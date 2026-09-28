/**
 * @vitest-environment node
 *
 * Regression — `sync:cancel` aborted syncs the caller had no business touching.
 *
 * It took an optional device id and aborted that device's sync, or with none
 * every sync on the server, with none of the locality and ownership checks
 * `sync:start` applies. Over `/api/invoke` any allowlisted account could stop
 * the desktop owner's sync of a local player — or another guest's — part-way
 * through a `delete-all` reset. The desktop window's behaviour is unchanged,
 * and the control below pins that.
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
import {
  installMusicMetadataMock,
  resetMusicMetadataMock,
  registerFixture,
} from "../harness/music-metadata-mock";
import { canRunDbTests, createFakeDevice, type FakeDevice } from "../harness";

installElectronMock();
installMusicMetadataMock();

vi.mock("../../main/sync/sync-executor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    copyFileToDevice: vi.fn(async (_deviceFs: unknown, src: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return true;
    }),
  };
});

vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
  isDeviceOnline: vi.fn().mockReturnValue(true),
  deviceRowToOnlineInput: vi.fn((row) => row),
}));
vi.mock("../../main/devices/usb-devices", () => ({
  refreshUsbSnapshot: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  getUsbSnapshot: vi.fn().mockReturnValue({ available: false, devices: [] }),
  listUsbDevices: vi.fn().mockResolvedValue({ available: false, devices: [] }),
  normalizeUsbId: vi.fn((v) => (v == null || v === "" ? null : String(v).toLowerCase().padStart(4, "0"))),
  usbDeviceMatches: vi.fn().mockReturnValue(false),
}));

const itDb = it.skipIf(!canRunDbTests);

const SYNC_OPTS = {
  syncType: "full",
  extraTrackPolicy: "keep",
  includeMusic: true,
  includePodcasts: false,
  includeAudiobooks: false,
  includePlaylists: false,
};

describe("sync:cancel is scoped to the caller", () => {
  let session: IpcSession;
  let root: string;
  let libraryDir: string;
  let device: FakeDevice;
  let deviceId: number;

  beforeEach(async () => {
    resetMusicMetadataMock();
    vi.clearAllMocks();
    if (!canRunDbTests) return;
    root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-test-"));
    const userDataDir = path.join(root, "userdata");
    libraryDir = path.join(root, "library");
    fs.mkdirSync(path.join(userDataDir, "userData"), { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    device = createFakeDevice(root);
    session = await setupIpcSession({ userDataDir });

    const file = path.join(libraryDir, "A/one.flac");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(200));
    registerFixture(file, {
      title: "One",
      artist: "A",
      album: "Alb",
      duration: 100,
      bitrate: 1000,
      codec: "FLAC",
    });
    const folder = { name: "Music", path: libraryDir, contentType: "music" };
    await session.invoke("library:addFolder", folder);
    await session.invoke("library:scan", { folders: [folder] });
    deviceId = (
      await session.invoke<{ id: number }>("device:add", {
        name: "Owner's Player",
        mountPath: device.mountPath,
      })
    ).id;
  });

  afterEach(() => {
    session?.cleanup();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("a web client cannot cancel the desktop owner's sync, named or bare", async () => {
    const running = session.invoke<{ status?: string; error?: string }>("sync:start", {
      deviceId,
      ...SYNC_OPTS,
    });

    const named = await session.invokeAsWebClient<{ error?: string }>("sync:cancel", deviceId);
    expect(named.error).toBeTruthy();

    const bare = await session.invokeAsWebClient<{ cancelled?: boolean; error?: string }>(
      "sync:cancel"
    );
    expect(bare.error).toBeUndefined();
    expect(bare.cancelled).toBe(false);

    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  itDb("control: the desktop window can still cancel it", async () => {
    const running = session.invoke<{ status?: string; error?: string }>("sync:start", {
      deviceId,
      ...SYNC_OPTS,
    });
    const cancel = await session.invoke<{ cancelled: boolean }>("sync:cancel");
    expect(cancel.cancelled).toBe(true);
    const result = await running;
    expect(result.status).not.toBe("completed");
  });

  itDb("between web logins, only the starter (or its own identity) may cancel", async () => {
    const { mayCancelSync } = await import("../../main/ipc/sync");
    const sync = {
      controller: new AbortController(),
      sessionId: "session-a",
      subject: null,
    };
    expect(mayCancelSync({ sessionId: "session-a" } as never, sync)).toBe(true);
    expect(mayCancelSync({ sessionId: "session-b" } as never, sync)).toBe(false);
    // The desktop window may cancel anything, as it always could.
    expect(mayCancelSync({} as never, sync)).toBe(true);
    // A desktop-started sync is never a web caller's to cancel.
    expect(
      mayCancelSync({ sessionId: "session-b" } as never, { ...sync, sessionId: undefined })
    ).toBe(false);
    // A caller whose session names no identity never matches a subject.
    expect(
      mayCancelSync({ sessionId: "session-b" } as never, { ...sync, subject: "local:alice" })
    ).toBe(false);
  });
});
