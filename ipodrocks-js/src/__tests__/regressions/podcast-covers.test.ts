/**
 * @vitest-environment node
 *
 * Regression coverage for `podcast-cover-extractor` — the new sidecar-writing
 * helper. Verifies it handles each branch: existing cover preserved, no
 * embedded picture, unsupported MIME, malformed file, and a clean PNG/JPEG
 * write that names the file by mime type.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  createTmpDir,
  cleanupTmp,
  installMusicMetadataMock,
  resetMusicMetadataMock,
  registerFixture,
} from "../harness";

installMusicMetadataMock();

import { ensureShowCoverArt, showFolderHasCover } from "../../main/podcasts/podcast-cover-extractor";

describe("podcast-cover-extractor — regressions", () => {
  let tmpDir: string;

  beforeEach(() => {
    resetMusicMetadataMock();
    tmpDir = createTmpDir("cover-regression-");
  });

  afterEach(() => {
    cleanupTmp(tmpDir);
  });

  it("returns null and preserves an existing cover.jpg", async () => {
    const showDir = path.join(tmpDir, "show");
    fs.mkdirSync(showDir, { recursive: true });
    const existing = path.join(showDir, "cover.jpg");
    fs.writeFileSync(existing, Buffer.from("preserve"));

    const audio = path.join(tmpDir, "audio.mp3");
    fs.writeFileSync(audio, Buffer.alloc(10));
    registerFixture(audio, { picture: [{ format: "image/jpeg", data: Buffer.from([1, 2]) } as never] });

    const result = await ensureShowCoverArt(audio, showDir);
    expect(result).toBeNull();
    expect(fs.readFileSync(existing).toString()).toBe("preserve");
  });

  it("returns null when no embedded picture is present", async () => {
    const showDir = path.join(tmpDir, "show2");
    const audio = path.join(tmpDir, "no-art.mp3");
    fs.writeFileSync(audio, Buffer.alloc(10));
    // No registerFixture call → default mock returns picture: undefined.

    const result = await ensureShowCoverArt(audio, showDir);
    expect(result).toBeNull();
    expect(showFolderHasCover(showDir)).toBe(false);
  });

  it("returns null for unsupported MIME (e.g. image/webp)", async () => {
    const showDir = path.join(tmpDir, "show3");
    const audio = path.join(tmpDir, "weird-mime.mp3");
    fs.writeFileSync(audio, Buffer.alloc(10));
    registerFixture(audio, { picture: [{ format: "image/webp", data: Buffer.from([0xff]) } as never] });

    const result = await ensureShowCoverArt(audio, showDir);
    expect(result).toBeNull();
    expect(showFolderHasCover(showDir)).toBe(false);
  });

  it("writes cover.jpg for JPEG art and cover.png for PNG art", async () => {
    const jpegShow = path.join(tmpDir, "jpegShow");
    const jpegAudio = path.join(tmpDir, "jpeg.mp3");
    fs.writeFileSync(jpegAudio, Buffer.alloc(10));
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    registerFixture(jpegAudio, { picture: [{ format: "image/jpeg", data: jpegBytes } as never] });
    const jpegResult = await ensureShowCoverArt(jpegAudio, jpegShow);
    expect(jpegResult?.written).toBe(path.join(jpegShow, "cover.jpg"));
    expect(fs.readFileSync(jpegResult!.written)).toEqual(jpegBytes);

    const pngShow = path.join(tmpDir, "pngShow");
    const pngAudio = path.join(tmpDir, "png.mp3");
    fs.writeFileSync(pngAudio, Buffer.alloc(10));
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    registerFixture(pngAudio, { picture: [{ format: "image/png", data: pngBytes } as never] });
    const pngResult = await ensureShowCoverArt(pngAudio, pngShow);
    expect(pngResult?.written).toBe(path.join(pngShow, "cover.png"));
    expect(fs.readFileSync(pngResult!.written)).toEqual(pngBytes);
  });

  it("treats cover.jpeg, cover.png as also satisfying showFolderHasCover", () => {
    const dirJpeg = path.join(tmpDir, "d1");
    fs.mkdirSync(dirJpeg, { recursive: true });
    fs.writeFileSync(path.join(dirJpeg, "cover.jpeg"), "x");
    expect(showFolderHasCover(dirJpeg)).toBe(true);

    const dirPng = path.join(tmpDir, "d2");
    fs.mkdirSync(dirPng, { recursive: true });
    fs.writeFileSync(path.join(dirPng, "cover.png"), "x");
    expect(showFolderHasCover(dirPng)).toBe(true);

    const dirNone = path.join(tmpDir, "d3");
    fs.mkdirSync(dirNone, { recursive: true });
    expect(showFolderHasCover(dirNone)).toBe(false);
  });
});
