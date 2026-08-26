/**
 * @vitest-environment node
 *
 * Issue #119: `Device.getTracks()` only walks AUDIO_EXTENSIONS, so a generated
 * `cover.jpg` is invisible to the normal extras/orphan-track comparison. Two
 * consequences before this fix: renaming an album folder left its cover.jpg
 * (and therefore the whole now-empty folder) behind forever, and turning on
 * "skip album artwork" never removed covers a previous sync had already
 * written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { findOrphanedAlbumArt } from "../../main/sync/sync-core";
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

describe("findOrphanedAlbumArt", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-orphan-art-"));
  });
  afterEach(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("flags a cover whose album folder no longer matches any library track", () => {
    const stalePath = path.join(workDir, "Artist", "OldAlbum", "cover.jpg");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, "stale");

    const currentPath = path.join(workDir, "Artist", "CurrentAlbum", "cover.jpg");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, "current");

    const libraryTracks = {
      "/library/Artist/CurrentAlbum/track.flac": {
        artist: "Artist",
        album: "CurrentAlbum",
      },
    };

    const orphans = findOrphanedAlbumArt(workDir, "music", libraryTracks);

    expect(orphans).toEqual([stalePath]);
  });

  it("flags every cover once skipAlbumArtwork is on, even for a still-current album", () => {
    const currentPath = path.join(workDir, "Artist", "CurrentAlbum", "cover.jpg");
    fs.mkdirSync(path.dirname(currentPath), { recursive: true });
    fs.writeFileSync(currentPath, "current");

    const libraryTracks = {
      "/library/Artist/CurrentAlbum/track.flac": {
        artist: "Artist",
        album: "CurrentAlbum",
      },
    };

    expect(findOrphanedAlbumArt(workDir, "music", libraryTracks)).toEqual([]);
    expect(
      findOrphanedAlbumArt(workDir, "music", libraryTracks, { skipAlbumArtwork: true })
    ).toEqual([currentPath]);
  });

  it("returns nothing for a device folder that doesn't exist yet", () => {
    const missing = path.join(workDir, "does-not-exist");
    expect(findOrphanedAlbumArt(missing, "music", {})).toEqual([]);
  });
});

const itDb = it.skipIf(!canRunDbTests);

function seedAudioOnDisk(dir: string, relPath: string, metadata: Parameters<typeof registerFixture>[1]): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(200));
  registerFixture(full, metadata);
  return full;
}

describe("Device sync — orphaned album art cleanup (issue #119)", () => {
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

  itDb("removes a renamed album's leftover cover and its now-empty folder", async () => {
    const trackPath = seedAudioOnDisk(libraryDir, "Artist/OldAlbum/01 - Track.flac", {
      title: "Track",
      artist: "Artist",
      album: "OldAlbum",
      duration: 120,
      bitrate: 1000,
      codec: "FLAC",
    });

    await session.invoke("library:addFolder", { name: "Music", path: libraryDir, contentType: "music" });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const devProfile = await session.invoke<{ id: number }>("device:add", {
      name: "OrphanArtDevice",
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

    // Simulate a leftover from a real (ffmpeg-generated) previous sync — the
    // fixtures here carry no embedded/folder art, so the app itself never
    // writes one, but a stale cover.jpg left by an earlier sync is exactly
    // what issue #119 reports.
    const staleCoverDir = path.join(device.musicDir, "Artist", "OldAlbum");
    expect(fs.existsSync(staleCoverDir)).toBe(true);
    const staleCoverPath = path.join(staleCoverDir, "cover.jpg");
    fs.writeFileSync(staleCoverPath, "stale-cover");

    // Rename the album: remove the old file, add a new one under a new tag.
    fs.rmSync(path.dirname(trackPath), { recursive: true, force: true });
    seedAudioOnDisk(libraryDir, "Artist/NewAlbum/01 - Track.flac", {
      title: "Track",
      artist: "Artist",
      album: "NewAlbum",
      duration: 120,
      bitrate: 1000,
      codec: "FLAC",
    });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const result = await session.invoke<{ removed: number }>("sync:start", {
      deviceId: devProfile.id,
      syncType: "full",
      extraTrackPolicy: "remove",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleCoverPath)).toBe(false);
    // The folder had nothing left in it once its cover was cleared too.
    expect(fs.existsSync(staleCoverDir)).toBe(false);
    expect(fs.existsSync(path.join(device.musicDir, "Artist", "NewAlbum"))).toBe(true);
  });

  itDb("removes existing covers once the device's skipAlbumArtwork setting is turned on", async () => {
    seedAudioOnDisk(libraryDir, "Artist/Album/01 - Track.flac", {
      title: "Track",
      artist: "Artist",
      album: "Album",
      duration: 120,
      bitrate: 1000,
      codec: "FLAC",
    });

    await session.invoke("library:addFolder", { name: "Music", path: libraryDir, contentType: "music" });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });

    const devProfile = await session.invoke<{ id: number }>("device:add", {
      name: "SkipArtworkDevice",
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

    // Plant a cover as if it had been generated before the user opted out.
    const coverPath = path.join(device.musicDir, "Artist", "Album", "cover.jpg");
    fs.writeFileSync(coverPath, "old-cover");

    await session.invoke("device:update", devProfile.id, { skipAlbumArtwork: true });

    const result = await session.invoke<{ removed: number }>("sync:start", {
      deviceId: devProfile.id,
      syncType: "full",
      extraTrackPolicy: "remove",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(coverPath)).toBe(false);
    // The track itself must survive — only the cover is gone.
    expect(
      fs.readdirSync(path.join(device.musicDir, "Artist", "Album")).some((f) => /\.flac$/i.test(f))
    ).toBe(true);
  });
});
