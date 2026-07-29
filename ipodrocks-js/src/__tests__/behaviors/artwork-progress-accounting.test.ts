/**
 * @vitest-environment node
 *
 * The sync progress bar raises its total only on "total"/"total_add" events but
 * advances the processed count on every "copy" event. Artwork generation must
 * therefore announce each cover it is about to write, or the processed count
 * overruns the total (e.g. "48/40 copied") and the bar reaches 100% while
 * tracks are still copying.
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
import type { SyncProgressEventName } from "../../../src/shared/types";

interface Event {
  event: SyncProgressEventName;
  path?: string;
  status?: string;
  contentType?: string;
}

function ffmpegAvailable(): boolean {
  try {
    return spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("artwork progress accounting", () => {
  let workDir: string;
  let deviceDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-progress-"));
    deviceDir = path.join(workDir, "device");
    fs.mkdirSync(deviceDir, { recursive: true });
  });
  afterAll(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /** Seed an album folder with a track placeholder and a cover image. */
  function seedAlbum(artist: string, album: string): string {
    const dir = path.join(workDir, "library", artist, album);
    fs.mkdirSync(dir, { recursive: true });
    const trackPath = path.join(dir, "01 Track.mp3");
    fs.writeFileSync(trackPath, Buffer.from("placeholder-audio"));
    const cover = path.join(dir, "cover.png");
    const r = spawnSync(
      getFfmpegPath(),
      ["-y", "-f", "lavfi", "-i", "color=c=blue:s=600x600", "-frames:v", "1", cover],
      { encoding: "utf8" }
    );
    expect(r.status).toBe(0);
    return trackPath;
  }

  it("emits one total_add for every artwork copy event", async () => {
    const tracks: Record<string, Record<string, unknown>> = {};
    for (const album of ["Album One", "Album Two", "Album Three"]) {
      tracks[seedAlbum("Some Artist", album)] = {
        artist: "Some Artist",
        album,
      };
    }

    const events: Event[] = [];
    const result = await copyAlbumArtworkToDevice(
      deviceDir,
      "music",
      tracks,
      undefined,
      (e) => events.push(e as Event),
      undefined,
      false,
      300
    );

    expect(result.copied).toBe(3);

    const copyEvents = events.filter(
      (e) => e.event === "copy" && e.contentType === "artwork"
    );
    const totalAdds = events.filter((e) => e.event === "total_add");

    expect(copyEvents).toHaveLength(3);
    // One announced item per reported item — the invariant the progress bar needs.
    const announced = totalAdds.reduce((sum, e) => sum + Number(e.path ?? 0), 0);
    expect(announced).toBe(copyEvents.length);
  });

  it("announces nothing when every cover is already up to date", async () => {
    const tracks: Record<string, Record<string, unknown>> = {};
    tracks[seedAlbum("Second Artist", "Cached Album")] = {
      artist: "Second Artist",
      album: "Cached Album",
    };

    const first: Event[] = [];
    await copyAlbumArtworkToDevice(
      deviceDir, "music", tracks, undefined,
      (e) => first.push(e as Event), undefined, false, 300
    );
    expect(first.filter((e) => e.event === "total_add")).toHaveLength(1);

    const second: Event[] = [];
    const result = await copyAlbumArtworkToDevice(
      deviceDir, "music", tracks, undefined,
      (e) => second.push(e as Event), undefined, false, 300
    );

    expect(result.skipped).toBe(1);
    expect(result.copied).toBe(0);
    // A no-op artwork pass must not inflate either counter.
    expect(second.filter((e) => e.event === "total_add")).toHaveLength(0);
    expect(
      second.filter((e) => e.event === "copy" && e.contentType === "artwork")
    ).toHaveLength(0);
  });
});
