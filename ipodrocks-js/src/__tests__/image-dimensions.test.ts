/**
 * @vitest-environment node
 *
 * The Rockbox cover generator decides whether an existing cover.jpg still
 * matches the requested max dimension, so the header parsers must read real
 * JPEG/PNG dimensions and must return null (rather than a wrong guess) for
 * anything they don't understand.
 */
import { describe, it, expect } from "vitest";

import {
  longestEdge,
  readImageDimensions,
} from "../main/utils/image-dimensions";

/** Minimal PNG: signature + IHDR chunk with the given dimensions. */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Minimal JPEG: SOI, an APPn segment of `appLength` bytes to push the frame
 * header off offset zero, then a SOFn frame header carrying the dimensions.
 */
function makeJpeg(
  width: number,
  height: number,
  marker = 0xc0,
  appLength = 16
): Buffer {
  const parts: number[] = [0xff, 0xd8];
  parts.push(0xff, 0xe0, (appLength >> 8) & 0xff, appLength & 0xff);
  for (let i = 0; i < appLength - 2; i++) parts.push(0x00);
  parts.push(0xff, marker, 0x00, 0x11, 0x08);
  parts.push((height >> 8) & 0xff, height & 0xff);
  parts.push((width >> 8) & 0xff, width & 0xff);
  for (let i = 0; i < 6; i++) parts.push(0x00);
  return Buffer.from(parts);
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readImageDimensions(makePng(1200, 800))).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it("reads baseline JPEG dimensions from SOF0", () => {
    expect(readImageDimensions(makeJpeg(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads progressive JPEG dimensions from SOF2", () => {
    expect(readImageDimensions(makeJpeg(300, 300, 0xc2))).toEqual({
      width: 300,
      height: 300,
    });
  });

  it("skips over large leading segments to find the frame header", () => {
    expect(readImageDimensions(makeJpeg(500, 250, 0xc0, 4096))).toEqual({
      width: 500,
      height: 250,
    });
  });

  it("returns null for data that is not a supported image", () => {
    expect(readImageDimensions(Buffer.from("not an image at all"))).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for a truncated JPEG with no frame header", () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("longestEdge", () => {
  it("returns the larger of width and height", () => {
    expect(longestEdge({ width: 1200, height: 800 })).toBe(1200);
    expect(longestEdge({ width: 300, height: 900 })).toBe(900);
  });

  it("passes null through so callers can fall back", () => {
    expect(longestEdge(null)).toBeNull();
  });
});
