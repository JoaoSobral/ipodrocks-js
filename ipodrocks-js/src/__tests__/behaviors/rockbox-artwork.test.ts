/**
 * @vitest-environment node
 *
 * Exercises the real Rockbox cover generator end-to-end with bundled ffmpeg:
 * an oversized source image must become a small BASELINE JPEG (Rockbox can't
 * decode progressive), re-runs must skip, and unreadable sources must fail
 * gracefully (fallback copy) without throwing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

import { installElectronMock } from "../harness/ipc-harness";

installElectronMock();

import { getFfmpegPath } from "../../main/utils/ffmpeg-path";
import {
  findAlbumArtSource,
  generateRockboxCover,
} from "../../main/sync/rockbox-cover";
import { SyncCancelled } from "../../main/sync/sync-core";

function ffmpegAvailable(): boolean {
  try {
    return spawnSync(getFfmpegPath(), ["-version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/** Parse a JPEG: is it baseline (SOF0) vs progressive (SOF2), and its size. */
function inspectJpeg(buf: Buffer): { soi: boolean; baseline: boolean; progressive: boolean; width: number; height: number } {
  const soi = buf[0] === 0xff && buf[1] === 0xd8;
  let baseline = false;
  let progressive = false;
  let width = 0;
  let height = 0;
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0) baseline = true;
    if (marker === 0xc2) progressive = true;
    if ((marker === 0xc0 || marker === 0xc2) && i + 9 < buf.length) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    // Standalone markers (no length) — advance by 2; others carry a length.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
    } else if (i + 3 < buf.length) {
      i += 2 + buf.readUInt16BE(i + 2);
    } else {
      break;
    }
  }
  return { soi, baseline, progressive, width, height };
}

const canRun = ffmpegAvailable();

describe.skipIf(!canRun)("Rockbox cover generation", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbx-cover-"));
  });
  afterAll(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeImage(name: string, size: string): string {
    const p = path.join(workDir, name);
    const r = spawnSync(getFfmpegPath(), ["-y", "-f", "lavfi", "-i", `color=c=red:s=${size}`, "-frames:v", "1", p], { encoding: "utf8" });
    expect(r.status).toBe(0);
    return p;
  }

  it("converts an oversized image to a baseline JPEG within the max dimension", async () => {
    const src = makeImage("big.png", "1200x1200");
    const dest = path.join(workDir, "AlbumA", "cover.jpg");

    const result = await generateRockboxCover(
      { kind: "file", path: src, mtimeMs: fs.statSync(src).mtimeMs },
      dest,
      { maxDim: 300 }
    );

    expect(result).toBe("written");
    expect(fs.existsSync(dest)).toBe(true);
    const info = inspectJpeg(fs.readFileSync(dest));
    expect(info.soi).toBe(true);
    expect(info.baseline).toBe(true);
    expect(info.progressive).toBe(false);
    expect(info.width).toBeLessThanOrEqual(300);
    expect(info.height).toBeLessThanOrEqual(300);
    expect(info.width).toBeGreaterThan(0);
  });

  it("skips regeneration when the cover is already up to date", async () => {
    const src = makeImage("b2.png", "800x600");
    const dest = path.join(workDir, "AlbumB", "cover.jpg");
    const source = { kind: "file" as const, path: src, mtimeMs: fs.statSync(src).mtimeMs };

    expect(await generateRockboxCover(source, dest, { maxDim: 300 })).toBe("written");
    const firstMtime = fs.statSync(dest).mtimeMs;
    expect(await generateRockboxCover(source, dest, { maxDim: 300 })).toBe("skipped");
    expect(fs.statSync(dest).mtimeMs).toBe(firstMtime);
  });

  it("never upscales a small source", async () => {
    const src = makeImage("small.png", "120x120");
    const dest = path.join(workDir, "AlbumC", "cover.jpg");
    await generateRockboxCover({ kind: "file", path: src, mtimeMs: fs.statSync(src).mtimeMs }, dest, { maxDim: 300 });
    const info = inspectJpeg(fs.readFileSync(dest));
    expect(info.width).toBeLessThanOrEqual(120);
  });

  it("falls back to a verbatim copy when ffmpeg can't decode the source", async () => {
    const src = path.join(workDir, "garbage.jpg");
    fs.writeFileSync(src, Buffer.from("not a real image"));
    const dest = path.join(workDir, "AlbumD", "cover.jpg");

    // Must not throw; falls back to copying the (bogus) source so at least
    // something is present.
    const result = await generateRockboxCover(
      { kind: "file", path: src, mtimeMs: fs.statSync(src).mtimeMs },
      dest,
      { maxDim: 300 }
    );
    expect(result).toBe("written");
    expect(fs.readFileSync(dest).toString()).toBe("not a real image");
  });

  it("regenerates when the max dimension is raised", async () => {
    const src = makeImage("resize-up.png", "1000x1000");
    const dest = path.join(workDir, "AlbumF", "cover.jpg");
    const source = { kind: "file" as const, path: src, mtimeMs: fs.statSync(src).mtimeMs };

    expect(await generateRockboxCover(source, dest, { maxDim: 200 })).toBe("written");
    expect(inspectJpeg(fs.readFileSync(dest)).width).toBeLessThanOrEqual(202);

    // The source art is untouched, so an mtime-only freshness check would skip
    // here and silently leave the cover at the old size.
    expect(await generateRockboxCover(source, dest, { maxDim: 500 })).toBe("written");
    const resized = inspectJpeg(fs.readFileSync(dest));
    expect(resized.width).toBeGreaterThan(300);
    expect(resized.width).toBeLessThanOrEqual(502);
  });

  it("regenerates when the max dimension is lowered", async () => {
    const src = makeImage("resize-down.png", "1000x1000");
    const dest = path.join(workDir, "AlbumG", "cover.jpg");
    const source = { kind: "file" as const, path: src, mtimeMs: fs.statSync(src).mtimeMs };

    expect(await generateRockboxCover(source, dest, { maxDim: 750 })).toBe("written");
    expect(await generateRockboxCover(source, dest, { maxDim: 200 })).toBe("written");
    expect(inspectJpeg(fs.readFileSync(dest)).width).toBeLessThanOrEqual(202);
  });

  it("still skips a small source that can never reach the max dimension", async () => {
    const src = makeImage("tiny.png", "150x150");
    const dest = path.join(workDir, "AlbumH", "cover.jpg");
    const source = { kind: "file" as const, path: src, mtimeMs: fs.statSync(src).mtimeMs };

    expect(await generateRockboxCover(source, dest, { maxDim: 300 })).toBe("written");
    // 150px art is never upscaled, so it legitimately stays under 300px — this
    // must not regenerate on every single sync.
    expect(await generateRockboxCover(source, dest, { maxDim: 300 })).toBe("skipped");
  });

  it("propagates cancellation instead of falling back to a verbatim copy", async () => {
    const src = makeImage("cancel.png", "1200x1200");
    const dest = path.join(workDir, "AlbumI", "cover.jpg");
    const controller = new AbortController();

    const pending = generateRockboxCover(
      { kind: "file", path: src, mtimeMs: fs.statSync(src).mtimeMs },
      dest,
      { maxDim: 300, signal: controller.signal }
    );
    controller.abort();

    // ffmpeg rejects with a plain Error("Cancelled"); it must surface as
    // SyncCancelled rather than being swallowed into the fallback copy.
    await expect(pending).rejects.toBeInstanceOf(SyncCancelled);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("prefers a folder-art file named cover/folder/front over others", async () => {
    const albumDir = path.join(workDir, "AlbumE");
    fs.mkdirSync(albumDir, { recursive: true });
    makeImage(path.join("AlbumE", "zzz-random.png"), "100x100");
    makeImage(path.join("AlbumE", "folder.png"), "100x100");

    const source = await findAlbumArtSource(albumDir, path.join(albumDir, "track.flac"));
    expect(source?.kind).toBe("file");
    if (source?.kind === "file") {
      expect(path.basename(source.path)).toBe("folder.png");
    }
  });
});
