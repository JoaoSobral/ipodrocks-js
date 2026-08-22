/**
 * @vitest-environment node
 *
 * Album-artwork failures must be reported as failures, but attributed to cover
 * art rather than to song data. This exercises the real generator against a
 * destination that cannot be created, so the failure is genuine rather than
 * mocked, and checks the failed album folders are named for the sync log.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { installElectronMock } from "../harness/ipc-harness";

installElectronMock();

import { getFfmpegPath } from "../../main/utils/ffmpeg-path";
import { copyAlbumArtworkToDevice } from "../../main/sync/sync-core";

interface Event {
  event: string;
  path?: string;
  status?: string;
  contentType?: string;
  message?: string;
}

function ffmpegAvailable(): boolean {
  try {
    return spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("album artwork failure reporting", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-artfail-"));
  });
  afterAll(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Seed an album folder with a track placeholder and real cover art. */
  function seedAlbum(root: string, artist: string, album: string): string {
    const dir = path.join(root, artist, album);
    fs.mkdirSync(dir, { recursive: true });
    const trackPath = path.join(dir, "01 Track.mp3");
    fs.writeFileSync(trackPath, Buffer.from("placeholder-audio"));
    const r = spawnSync(
      getFfmpegPath(),
      [
        "-y", "-f", "lavfi", "-i", "color=c=green:s=400x400",
        "-frames:v", "1", path.join(dir, "cover.png"),
      ],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);
    return trackPath;
  }

  it("counts a failed cover and names the album folder", async () => {
    const libRoot = path.join(workDir, "lib-fail");
    const deviceDir = path.join(workDir, "device-fail");
    fs.mkdirSync(deviceDir, { recursive: true });

    const trackPath = seedAlbum(libRoot, "Blocked Artist", "Blocked Album");

    // Plant a FILE where the album directory must be created, so the generator
    // cannot write its cover and genuinely fails.
    fs.mkdirSync(path.join(deviceDir, "Blocked Artist"), { recursive: true });
    fs.writeFileSync(path.join(deviceDir, "Blocked Artist", "Blocked Album"), "not a directory");

    const events: Event[] = [];
    const result = await copyAlbumArtworkToDevice(
      deviceDir,
      "music",
      { [trackPath]: { artist: "Blocked Artist", album: "Blocked Album" } },
      { progressCallback: (e) => events.push(e as Event), maxDim: 300 }
    );

    expect(result.errors).toBe(1);
    expect(result.copied).toBe(0);
    expect(result.failedAlbums).toHaveLength(1);
    expect(result.failedAlbums[0]).toContain("Blocked Album");

    // The failure is reported as artwork, never as track content.
    const errorEvents = events.filter((e) => e.event === "copy" && e.status === "error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].contentType).toBe("artwork");
  });

  it("reports no failures when every cover is generated", async () => {
    const libRoot = path.join(workDir, "lib-ok");
    const deviceDir = path.join(workDir, "device-ok");
    fs.mkdirSync(deviceDir, { recursive: true });

    const trackPath = seedAlbum(libRoot, "Fine Artist", "Fine Album");

    const result = await copyAlbumArtworkToDevice(
      deviceDir,
      "music",
      { [trackPath]: { artist: "Fine Artist", album: "Fine Album" } },
      { maxDim: 300 }
    );

    expect(result.copied).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.failedAlbums).toEqual([]);
  });
});
