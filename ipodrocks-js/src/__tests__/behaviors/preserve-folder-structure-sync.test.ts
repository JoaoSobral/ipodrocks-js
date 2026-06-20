/**
 * @vitest-environment node
 *
 * Issue #82: with "mirror library folder structure" enabled, a full sync must
 * reproduce the source folder layout 1:1 on the device — including album folders
 * that carry the year (e.g. "Levels (2011)") — and the copied file must be
 * byte-identical to the source. A second sync must be idempotent (0 copies).
 *
 * Exercises the real sync:start IPC handler against a tmp library and a tmp
 * "device" mount, using DIRECT COPY (default device codec) so no real encoder
 * is needed and content can be compared exactly.
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

const REL = "Avicii/Levels (2011)/Avicii - Levels - 01 - Levels.flac";
const CONTENT = Buffer.from("FLAC\x00known-audio-bytes-for-integrity-check");

function seedKnownTrack(dir: string): string {
  const full = path.join(dir, REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, CONTENT);
  registerFixture(full, {
    title: "Levels",
    artist: "Avicii",
    // Album tag intentionally omits the year — the folder name carries it.
    album: "Levels",
    genre: "Dance",
    trackNumber: 1,
    duration: 200,
    bitrate: 1000,
    codec: "FLAC",
  });
  return full;
}

describe("Sync — preserve folder structure (issue #82)", () => {
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

  async function scanAndAddDevice(): Promise<number> {
    await session.invoke("library:addFolder", {
      name: "Music",
      path: libraryDir,
      contentType: "music",
    });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });
    const dev = await session.invoke<{ id: number }>("device:add", {
      name: "MirrorDevice",
      mountPath: device.mountPath,
    });
    return dev.id;
  }

  itDb("mirrors the source path 1:1 and copies byte-identical content", async () => {
    const srcPath = seedKnownTrack(libraryDir);
    const deviceId = await scanAndAddDevice();

    const result = await session.invoke<{ status: string; synced: number; errors: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "full",
        extraTrackPolicy: "keep",
        preserveFolderStructure: true,
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.errors).toBe(0);
    expect(result.synced).toBe(1);

    // Name integrity: exact mirrored path (year + parens preserved).
    const expected = path.join(device.musicDir, REL);
    expect(fs.existsSync(expected)).toBe(true);
    // Content integrity: bytes match the source exactly.
    expect(fs.readFileSync(expected).equals(fs.readFileSync(srcPath))).toBe(true);
  });

  itDb("a second sync with no changes copies nothing (idempotent with preserved names)", async () => {
    seedKnownTrack(libraryDir);
    const deviceId = await scanAndAddDevice();

    const opts = {
      deviceId,
      syncType: "full" as const,
      extraTrackPolicy: "keep" as const,
      preserveFolderStructure: true,
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    };

    const first = await session.invoke<{ synced: number }>("sync:start", opts);
    expect(first.synced).toBe(1);

    const deviceFile = path.join(device.musicDir, REL);
    const firstMtime = fs.statSync(deviceFile).mtimeMs;

    const second = await session.invoke<{ synced: number }>("sync:start", opts);
    expect(second.synced).toBe(0);
    expect(fs.statSync(deviceFile).mtimeMs).toBe(firstMtime);
  });

  itDb("with the toggle off, the device path is rebuilt from tags (year dropped)", async () => {
    seedKnownTrack(libraryDir);
    const deviceId = await scanAndAddDevice();

    await session.invoke("sync:start", {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "keep",
      preserveFolderStructure: false,
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(
      fs.existsSync(path.join(device.musicDir, "Avicii/Levels/Avicii - Levels - 01 - Levels.flac"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(device.musicDir, "Avicii/Levels (2011)/Avicii - Levels - 01 - Levels.flac"))
    ).toBe(false);
  });
});
