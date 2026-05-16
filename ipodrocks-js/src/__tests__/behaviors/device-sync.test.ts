/**
 * @vitest-environment node
 *
 * Behavioral journey for device sync — exercises the real `sync:start` IPC
 * handler against a tmp library and a tmp "device" mount.
 *
 * Drives the full IPC seam: library:addFolder → library:scan → device:add →
 * sync:start. Mocks Electron, sync-executor (so file copies stay in tmp),
 * device-online (mounts are always online), and music-metadata (no real
 * audio decoding).
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

vi.mock("../../main/sync/sync-executor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    copyFileToDevice: vi.fn(async (src: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return true;
    }),
  };
});

vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

const itDb = it.skipIf(!canRunDbTests);

function seedAudioOnDisk(dir: string, relPath: string, metadata: Parameters<typeof registerFixture>[1]): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(200));
  registerFixture(full, metadata);
  return full;
}

describe("Device sync — IPC journey", () => {
  let session: IpcSession;
  let userDataDir: string;
  let libraryDir: string;
  let device: FakeDevice;

  beforeEach(async () => {
    resetMusicMetadataMock();
    vi.clearAllMocks();
    if (!canRunDbTests) return;

    // Use a tmp dir under $HOME so validateFolderPath's allowlist accepts it.
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
      const root = path.dirname(userDataDir);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("scans library, adds device, syncs music files onto the device mount", async () => {
    seedAudioOnDisk(libraryDir, "Artist/Album/01 - Track A.flac", {
      title: "Track A",
      artist: "Artist",
      album: "Album",
      genre: "Rock",
      trackNumber: 1,
      duration: 200,
      bitrate: 1000,
      codec: "FLAC",
    });
    seedAudioOnDisk(libraryDir, "Artist/Album/02 - Track B.flac", {
      title: "Track B",
      artist: "Artist",
      album: "Album",
      genre: "Rock",
      trackNumber: 2,
      duration: 220,
      bitrate: 1000,
      codec: "FLAC",
    });

    const folder = await session.invoke<number | { error: string }>(
      "library:addFolder",
      { name: "Music", path: libraryDir, contentType: "music" }
    );
    expect(typeof folder).toBe("number");

    const scan = await session.invoke<{ filesAdded: number }>(
      "library:scan",
      { folders: [{ name: "Music", path: libraryDir, contentType: "music" }] }
    );
    expect(scan.filesAdded).toBe(2);

    const devProfile = await session.invoke<{ id: number; name: string }>(
      "device:add",
      { name: "TestDevice", mountPath: device.mountPath }
    );
    expect(devProfile.id).toBeGreaterThan(0);

    const syncResult = await session.invoke<{
      status: string;
      synced: number;
      errors: number;
    }>("sync:start", {
      deviceId: devProfile.id,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(syncResult.status).toBe("completed");
    expect(syncResult.errors).toBe(0);
    expect(syncResult.synced).toBe(2);

    const filesOnDevice = fs
      .readdirSync(device.musicDir, { recursive: true })
      .filter((p) => typeof p === "string" && /\.(flac|mp3)$/i.test(p as string));
    expect(filesOnDevice.length).toBe(2);
  });

  itDb("re-syncing after removing a library track removes the file from the device", async () => {
    seedAudioOnDisk(libraryDir, "X/keep.flac", {
      title: "Keep",
      artist: "X",
      album: "Alb",
      duration: 120,
      bitrate: 1000,
      codec: "FLAC",
    });
    const removePath = seedAudioOnDisk(libraryDir, "X/remove.flac", {
      title: "Remove",
      artist: "X",
      album: "Alb",
      duration: 130,
      bitrate: 1000,
      codec: "FLAC",
    });

    await session.invoke("library:addFolder", { name: "Music", path: libraryDir, contentType: "music" });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const devProfile = await session.invoke<{ id: number }>("device:add", {
      name: "TestDevice2",
      mountPath: device.mountPath,
    });

    await session.invoke("sync:start", {
      deviceId: devProfile.id,
      syncType: "full",
      extraTrackPolicy: "remove",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(fs.readdirSync(device.musicDir, { recursive: true }).length).toBeGreaterThan(0);

    fs.rmSync(removePath);
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const second = await session.invoke<{ removed: number }>("sync:start", {
      deviceId: devProfile.id,
      syncType: "full",
      extraTrackPolicy: "remove",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(second.removed).toBeGreaterThanOrEqual(1);
    const remaining = fs
      .readdirSync(device.musicDir, { recursive: true })
      .filter((p) => typeof p === "string" && /\.flac$/i.test(p as string));
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toMatch(/keep/i);
  });
});
