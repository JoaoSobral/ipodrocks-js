/**
 * @vitest-environment node
 *
 * Regression: running `sync:start` twice with no library changes between
 * runs must not re-copy anything on the second run.
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
import {
  canRunDbTests,
  createFakeDevice,
  type FakeDevice,
} from "../harness";

installElectronMock();
installMusicMetadataMock();

vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

const itDb = it.skipIf(!canRunDbTests);

describe("sync — idempotency regression", () => {
  let session: IpcSession;
  let userDataDir: string;
  let libraryDir: string;
  let device: FakeDevice;

  beforeEach(async () => {
    resetMusicMetadataMock();
    vi.clearAllMocks();
    if (!canRunDbTests) return;
    const root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-test-"));
    userDataDir = path.join(root, "userdata");
    libraryDir = path.join(root, "library");
    fs.mkdirSync(path.join(userDataDir, "userData"), { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
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

  itDb("second sync with no library changes copies zero files", async () => {
    const full = path.join(libraryDir, "Artist/Album/01 - Track.flac");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(200));
    registerFixture(full, {
      title: "Track",
      artist: "Artist",
      album: "Album",
      genre: "Rock",
      trackNumber: 1,
      duration: 200,
      bitrate: 1000,
      codec: "FLAC",
    });

    await session.invoke("library:addFolder", {
      name: "Music",
      path: libraryDir,
      contentType: "music",
    });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });
    const profile = await session.invoke<{ id: number }>("device:add", {
      name: "IdempotencyDevice",
      mountPath: device.mountPath,
    });

    const opts = {
      deviceId: profile.id,
      syncType: "full" as const,
      extraTrackPolicy: "keep" as const,
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    };

    const first = await session.invoke<{ synced: number }>("sync:start", opts);
    expect(first.synced).toBe(1);

    const fileOnDevice = path.join(device.musicDir, "Artist", "Album", "01 - Track.flac");
    expect(fs.existsSync(fileOnDevice)).toBe(true);
    const firstMtime = fs.statSync(fileOnDevice).mtimeMs;

    const second = await session.invoke<{ synced: number; status: string }>(
      "sync:start",
      opts
    );

    expect(second.status).toBe("completed");
    expect(second.synced).toBe(0);
    // Idempotent: file is still there and was not overwritten.
    expect(fs.statSync(fileOnDevice).mtimeMs).toBe(firstMtime);
  });
});
