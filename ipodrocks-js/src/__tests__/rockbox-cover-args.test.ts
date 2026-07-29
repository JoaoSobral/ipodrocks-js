/**
 * @vitest-environment node
 *
 * The generated Rockbox cover must be a BASELINE JPEG (Rockbox can't decode
 * progressive), fit within the requested max dimension without upscaling, and
 * carry no metadata. These are guaranteed by the ffmpeg argv, so we assert on
 * the pure arg builder directly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../main/utils/ffmpeg-path", () => ({ getFfmpegPath: () => "ffmpeg" }));

import { buildCoverFfmpegArgs } from "../main/sync/rockbox-cover";

describe("buildCoverFfmpegArgs", () => {
  const args = buildCoverFfmpegArgs("/src/art.png", "/out/cover.jpg", 300);
  const joined = args.join(" ");

  it("invokes ffmpeg with the source and dest", () => {
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("/src/art.png");
    expect(args[args.length - 1]).toBe("/out/cover.jpg");
  });

  it("encodes baseline JPEG (mjpeg encoder cannot emit progressive)", () => {
    expect(args).toContain("-c:v");
    expect(args).toContain("mjpeg");
    expect(args).toContain("-pix_fmt");
    expect(args).toContain("yuvj420p");
  });

  it("fits within the max dimension without upscaling", () => {
    expect(joined).toContain("min(iw,300)");
    expect(joined).toContain("min(ih,300)");
    expect(joined).toContain("force_original_aspect_ratio=decrease");
  });

  it("respects a different max dimension", () => {
    const big = buildCoverFfmpegArgs("/s.jpg", "/d.jpg", 750).join(" ");
    expect(big).toContain("min(iw,750)");
  });

  it("strips metadata and audio", () => {
    expect(args).toContain("-map_metadata");
    expect(args).toContain("-1");
    expect(args).toContain("-an");
  });
});
