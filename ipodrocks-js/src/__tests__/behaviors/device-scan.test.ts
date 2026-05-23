/**
 * @vitest-environment node
 *
 * Behavioral journey for `Device.getTracks` — the walk that enumerates audio
 * files already on a connected device, which feeds the sync diff.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createTmpDir,
  cleanupTmp,
  createFakeDevice,
  type FakeDevice,
} from "../harness";

import { Device } from "../../main/devices/device";
import type { DeviceProfile } from "../../shared/types";

function makeDevice(mountPath: string): Device {
  return new Device({
    id: 1,
    name: "Test Device",
    mountPath,
    musicFolder: "Music",
    podcastFolder: "Podcasts",
    audiobookFolder: "Audiobooks",
    playlistFolder: "Playlists",
    modelId: null,
    defaultCodecConfigId: null,
  } as DeviceProfile);
}

describe("Device — getTracks", () => {
  let tmpDir: string;
  let fake: FakeDevice;

  beforeEach(() => {
    tmpDir = createTmpDir("device-scan-");
    fake = createFakeDevice(tmpDir);
  });

  afterEach(() => {
    cleanupTmp(tmpDir);
  });

  it("skips macOS AppleDouble (._) sidecar files (issue #77)", async () => {
    const albumDir = path.join(fake.musicDir, "Artist", "Album");
    fs.mkdirSync(albumDir, { recursive: true });
    fs.writeFileSync(path.join(albumDir, "05 Mirage.ogg"), Buffer.alloc(2048));
    fs.writeFileSync(path.join(albumDir, "._05 Mirage.ogg"), Buffer.alloc(82));
    fs.writeFileSync(path.join(albumDir, "._.DS_Store"), Buffer.alloc(4096));

    const device = makeDevice(fake.mountPath);
    const tracks = await device.getTracks("music");

    expect(tracks.size).toBe(1);
    const [entry] = [...tracks.entries()];
    expect(path.basename(entry[0])).toBe("05 Mirage.ogg");
    expect(entry[1].filename).toBe("05 Mirage");
  });
});
