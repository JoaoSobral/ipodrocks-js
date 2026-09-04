/**
 * @vitest-environment node
 *
 * Behavioral journey for the Sync tab's Orphan & Reset Policy, through the real
 * `sync:start` IPC handler against a tmp library and a tmp "device" mount.
 *
 * Two behaviours are pinned here:
 *
 * - **"Remove orphans" sweeps every content type.** It used to visit only the
 *   content types this sync had something to copy to (`willRunPodcast` was
 *   `Object.keys(podcastLibraryTracks).length > 0`), so a device full of
 *   podcasts survived "remove orphans" untouched whenever the selection had no
 *   podcasts — silently, with nothing in the report to say so.
 *
 * - **"Delete all" erases before it enumerates.** The compare pass reads the
 *   device's file listing, so a wipe performed after that listing would leave
 *   the sync convinced everything was still there and copy nothing back: an
 *   empty device and a "0 synced" report.
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
    copyFileToDevice: vi.fn(async (src: string, dest: string) => {
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
  normalizeUsbId: vi.fn((v) =>
    v == null || v === "" ? null : String(v).toLowerCase().padStart(4, "0")
  ),
  usbDeviceMatches: vi.fn().mockReturnValue(false),
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

/** Drop a file on the device that no library track accounts for. */
function plantOnDevice(dir: string, relPath: string): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(120));
  return full;
}

function audioFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((p): p is string => typeof p === "string" && /\.(flac|mp3)$/i.test(p));
}

describe("Orphan & Reset Policy", () => {
  let session: IpcSession;
  let userDataDir: string;
  let libraryDir: string;
  let device: FakeDevice;
  let deviceId: number;

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

    seedAudioOnDisk(libraryDir, "Artist/Album/01 - Song.flac", {
      title: "Song",
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
      name: "PolicyDevice",
      mountPath: device.mountPath,
    });
    deviceId = profile.id;
  });

  afterEach(() => {
    session?.cleanup();
    try {
      fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  itDb("removes orphans from podcasts and audiobooks, not just music", async () => {
    // The library holds one music track and nothing else, so under the old
    // gating the podcast and audiobook folders were never even looked at.
    plantOnDevice(device.musicDir, "Stale/old-song.flac");
    plantOnDevice(device.podcastsDir, "Some Show/episode-42.mp3");
    plantOnDevice(device.audiobooksDir, "Some Book/chapter-01.mp3");

    const result = await session.invoke<{ status: string; removed: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "full",
        extraTrackPolicy: "remove",
        includeMusic: true,
        includePodcasts: true,
        includeAudiobooks: true,
        includePlaylists: false,
      }
    );

    expect(result.status).toBe("completed");
    expect(audioFilesUnder(device.podcastsDir)).toEqual([]);
    expect(audioFilesUnder(device.audiobooksDir)).toEqual([]);

    // The music the library does account for is still there.
    const music = audioFilesUnder(device.musicDir);
    expect(music).toHaveLength(1);
    expect(music[0]).toMatch(/Song/i);
  });

  itDb("keeps podcasts and audiobooks under the keep policy", async () => {
    plantOnDevice(device.podcastsDir, "Some Show/episode-42.mp3");
    plantOnDevice(device.audiobooksDir, "Some Book/chapter-01.mp3");

    await session.invoke("sync:start", {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
      includePodcasts: true,
      includeAudiobooks: true,
      includePlaylists: false,
    });

    expect(audioFilesUnder(device.podcastsDir)).toHaveLength(1);
    expect(audioFilesUnder(device.audiobooksDir)).toHaveLength(1);
  });

  itDb("delete-all erases the content folders and rebuilds them in the same run", async () => {
    // Seed the device as if a previous sync had filled it, including a file in
    // the exact place this sync will want to write.
    plantOnDevice(device.musicDir, "Artist/Album/01 - Song.flac");
    plantOnDevice(device.musicDir, "Ancient/junk.mp3");
    plantOnDevice(device.podcastsDir, "Some Show/episode-42.mp3");
    plantOnDevice(device.audiobooksDir, "Some Book/chapter-01.mp3");
    const strayNonAudio = plantOnDevice(device.musicDir, "Ancient/notes.txt");

    const result = await session.invoke<{ status: string; synced: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "full",
        extraTrackPolicy: "delete-all",
        includeMusic: true,
        includePodcasts: true,
        includeAudiobooks: true,
        includePlaylists: false,
      }
    );

    expect(result.status).toBe("completed");

    // Rebuilt: the wipe happened before the compare, so the library track was
    // copied back rather than skipped as already-present.
    expect(result.synced).toBeGreaterThanOrEqual(1);
    const music = audioFilesUnder(device.musicDir);
    expect(music).toHaveLength(1);
    expect(music[0]).toMatch(/Song/i);

    // Erased: everything else in those folders is gone, audio or not.
    expect(fs.existsSync(strayNonAudio)).toBe(false);
    expect(audioFilesUnder(device.podcastsDir)).toEqual([]);
    expect(audioFilesUnder(device.audiobooksDir)).toEqual([]);

    // The folders themselves survive, ready for the next sync.
    for (const dir of [device.musicDir, device.podcastsDir, device.audiobooksDir]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
  });

  itDb("delete-all leaves the Playlists folder alone", async () => {
    const playlist = path.join(device.playlistsDir, "Keep Me.m3u");
    fs.writeFileSync(playlist, "#EXTM3U\n");

    await session.invoke("sync:start", {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "delete-all",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(fs.existsSync(device.playlistsDir)).toBe(true);
  });
});
