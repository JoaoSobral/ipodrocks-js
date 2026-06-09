/**
 * @vitest-environment node
 *
 * Behavioral journey for custom-sync exclude polarity. Mirrors the setup in
 * device-sync.test.ts: real `sync:start` IPC handler, mocked file copy,
 * mocked music-metadata, tmp library + tmp "device" mount.
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

function seedAudioOnDisk(
  dir: string,
  relPath: string,
  metadata: Parameters<typeof registerFixture>[1]
): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(200));
  registerFixture(full, metadata);
  return full;
}

describe("Custom sync — exclude polarity", () => {
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
      const root = path.dirname(userDataDir);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function seedAndScan(): Promise<number> {
    seedAudioOnDisk(libraryDir, "ArtistA/Alb/01 - A1.flac", {
      title: "A1", artist: "ArtistA", album: "Alb", genre: "Rock",
      trackNumber: 1, duration: 200, bitrate: 1000, codec: "FLAC",
    });
    seedAudioOnDisk(libraryDir, "ArtistA/Alb/02 - A2.flac", {
      title: "A2", artist: "ArtistA", album: "Alb", genre: "Rock",
      trackNumber: 2, duration: 200, bitrate: 1000, codec: "FLAC",
    });
    seedAudioOnDisk(libraryDir, "ArtistB/Alb/01 - B1.flac", {
      title: "B1", artist: "ArtistB", album: "Alb", genre: "Rock",
      trackNumber: 1, duration: 200, bitrate: 1000, codec: "FLAC",
    });
    seedAudioOnDisk(libraryDir, "ArtistB/Alb/02 - B2.flac", {
      title: "B2", artist: "ArtistB", album: "Alb", genre: "Rock",
      trackNumber: 2, duration: 200, bitrate: 1000, codec: "FLAC",
    });

    await session.invoke("library:addFolder", {
      name: "Music", path: libraryDir, contentType: "music",
    });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const devProfile = await session.invoke<{ id: number }>("device:add", {
      name: "TestDevice", mountPath: device.mountPath,
    });
    return devProfile.id;
  }

  itDb("exclude mode with one artist selected syncs only the other artist's tracks", async () => {
    const deviceId = await seedAndScan();

    const result = await session.invoke<{
      status: string; synced: number; errors: number;
    }>("sync:start", {
      deviceId,
      syncType: "custom",
      extraTrackPolicy: "keep",
      ignoreSpaceCheck: false,
      selections: {
        mode: "exclude",
        albums: [],
        artists: ["ArtistA"],
        genres: [],
        podcasts: [],
        audiobooks: [],
        playlists: [],
      },
    });

    expect(result.status).toBe("completed");
    expect(result.errors).toBe(0);
    expect(result.synced).toBe(2);

    const files = fs.readdirSync(device.musicDir, { recursive: true })
      .filter((p) => typeof p === "string" && /\.flac$/i.test(p as string))
      .map(String);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.includes("B1") || f.includes("B2"))).toBe(true);
    expect(files.some((f) => f.includes("A1") || f.includes("A2"))).toBe(false);
  });

  itDb("exclude mode with empty selections syncs everything", async () => {
    const deviceId = await seedAndScan();

    const result = await session.invoke<{ synced: number }>("sync:start", {
      deviceId,
      syncType: "custom",
      extraTrackPolicy: "keep",
      ignoreSpaceCheck: false,
      selections: {
        mode: "exclude",
        albums: [], artists: [], genres: [],
        podcasts: [], audiobooks: [], playlists: [],
      },
    });

    expect(result.synced).toBe(4);
    const files = fs.readdirSync(device.musicDir, { recursive: true })
      .filter((p) => typeof p === "string" && /\.flac$/i.test(p as string));
    expect(files.length).toBe(4);
  });

  itDb("include mode with one artist selected syncs only that artist's tracks (regression)", async () => {
    const deviceId = await seedAndScan();

    const result = await session.invoke<{ synced: number }>("sync:start", {
      deviceId,
      syncType: "custom",
      extraTrackPolicy: "keep",
      ignoreSpaceCheck: false,
      selections: {
        mode: "include",
        albums: [],
        artists: ["ArtistA"],
        genres: [],
        podcasts: [],
        audiobooks: [],
        playlists: [],
      },
    });

    expect(result.synced).toBe(2);
    const files = fs.readdirSync(device.musicDir, { recursive: true })
      .filter((p) => typeof p === "string" && /\.flac$/i.test(p as string))
      .map(String);
    expect(files.every((f) => f.includes("A1") || f.includes("A2"))).toBe(true);
  });
});
