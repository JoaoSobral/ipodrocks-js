/**
 * @vitest-environment node
 *
 * Covers the async filesystem walks in `Device.getTracks` and
 * `Device.getContentStats`. These walks run in the Electron main process
 * during `device:check` and `sync:start`; on slow USB hosts the previous
 * synchronous `fs.readdirSync` blocked the event loop for minutes (issue #70).
 *
 * The tests verify:
 *  - non-empty results match what's on disk
 *  - missing folders return empty results
 *  - non-audio files are ignored by `getTracks`
 *  - `cancelSignal` aborts the walk and returns partial results without
 *    enumerating the remaining files (so callers can stop the sync queue).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Device } from "../main/devices/device";
import type { DeviceProfile } from "../shared/types";

let tmpMount: string;

function makeDevice(): Device {
  const profile = {
    id: 1,
    name: "TestDevice",
    mountPath: tmpMount,
    musicFolder: "Music",
    podcastFolder: "Podcasts",
    audiobookFolder: "Audiobooks",
    playlistFolder: "Playlists",
  } as DeviceProfile;
  return new Device(profile);
}

function writeFile(rel: string, size = 64): string {
  const full = path.join(tmpMount, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(size));
  return full;
}

beforeEach(() => {
  tmpMount = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-walk-"));
});

afterEach(() => {
  fs.rmSync(tmpMount, { recursive: true, force: true });
});

describe("Device.getTracks (async walk)", () => {
  it("returns a Map of audio files under the music folder", async () => {
    const a = writeFile("Music/Artist/album/01 - Song.mp3");
    const b = writeFile("Music/Artist/album/02 - Song.flac");
    writeFile("Music/cover.jpg"); // non-audio — ignored

    const tracks = await makeDevice().getTracks("music");

    expect(tracks.size).toBe(2);
    expect(tracks.has(a)).toBe(true);
    expect(tracks.has(b)).toBe(true);
    expect(tracks.get(a)?.fileSize).toBe(64);
  });

  it("returns an empty map when the content folder does not exist", async () => {
    const tracks = await makeDevice().getTracks("audiobook");
    expect(tracks.size).toBe(0);
  });

  it("aborts mid-walk when the cancel signal fires and returns partial results", async () => {
    for (let i = 0; i < 50; i++) {
      writeFile(`Music/album/${String(i).padStart(3, "0")}.mp3`);
    }

    const controller = new AbortController();
    let seen = 0;
    const tracks = await makeDevice().getTracks("music", {
      cancelSignal: controller.signal,
      progressCallback: (_p, count) => {
        seen = count;
        // Abort after the walk has observed several files.
        if (count >= 3) controller.abort();
      },
    });

    expect(controller.signal.aborted).toBe(true);
    expect(seen).toBeGreaterThanOrEqual(3);
    // The walk must stop early — not enumerate every file on disk.
    expect(tracks.size).toBeLessThan(50);
  });

  it("returns an empty map immediately when signal is already aborted", async () => {
    writeFile("Music/01.mp3");
    writeFile("Music/02.mp3");

    const controller = new AbortController();
    controller.abort();

    const tracks = await makeDevice().getTracks("music", { cancelSignal: controller.signal });
    expect(tracks.size).toBe(0);
  });
});

describe("Device.getContentStats (async walk)", () => {
  it("aggregates file count and total size across nested folders", async () => {
    writeFile("Music/a.mp3", 100);
    writeFile("Music/sub/b.flac", 200);
    writeFile("Music/sub/deeper/c.opus", 300);

    const stats = await makeDevice().getContentStats("music");
    expect(stats.fileCount).toBe(3);
    expect(stats.totalGb).toBeCloseTo(600 / 1024 ** 3, 10);
  });

  it("returns zeros when the content folder does not exist", async () => {
    const stats = await makeDevice().getContentStats("podcast");
    expect(stats.fileCount).toBe(0);
    expect(stats.totalGb).toBe(0);
  });

  it("stops walking when the cancel signal is already aborted", async () => {
    for (let i = 0; i < 20; i++) writeFile(`Music/${i}.mp3`);
    const controller = new AbortController();
    controller.abort();

    const stats = await makeDevice().getContentStats("music", { cancelSignal: controller.signal });
    expect(stats.fileCount).toBe(0);
  });
});
