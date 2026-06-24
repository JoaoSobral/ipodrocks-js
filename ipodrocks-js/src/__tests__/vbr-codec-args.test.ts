/**
 * @vitest-environment node
 *
 * Verifies that the `vbr` flag on ConversionSettings switches lossy ffmpeg
 * codecs from a fixed `-b:a` bitrate target to a variable-bitrate quality
 * target (`-q:a`), and is ignored for codecs that have no VBR mode.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("../main/utils/ffmpeg-path", () => ({ getFfmpegPath: () => "ffmpeg" }));

import { convertWithCodec } from "../main/sync/sync-conversion";

/** Run a conversion with mocked spawn and return the captured ffmpeg argv. */
async function captureArgs(
  settings: Parameters<typeof convertWithCodec>[2]
): Promise<string[]> {
  let captured: string[] = [];
  spawnMock.mockImplementation((cmd: string, args: string[]) => {
    captured = [cmd, ...args];
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // Encoder output path is the last arg — write a stub so the move succeeds.
    fs.writeFileSync(args[args.length - 1], "ENCODED");
    setImmediate(() => proc.emit("close", 0));
    return proc;
  });

  await convertWithCodec("/src/track.flac", "/tmp/ipr-vbr-out/track.mp3", settings);
  return captured;
}

afterEach(() => vi.clearAllMocks());

describe("VBR conversion args", () => {
  it("uses a quality target (-q:a) for mp3 when vbr is enabled", async () => {
    const args = await captureArgs({ codec: "mp3", bitrate: 256, vbr: true });
    expect(args).toContain("-q:a");
    expect(args).not.toContain("-b:a");
  });

  it("uses a fixed bitrate (-b:a) for mp3 when vbr is disabled", async () => {
    const args = await captureArgs({ codec: "mp3", bitrate: 256, vbr: false });
    expect(args).toContain("-b:a");
    expect(args).toContain("256k");
    expect(args).not.toContain("-q:a");
  });

  it("maps a higher bitrate to a better (lower) mp3 quality level", async () => {
    const hi = await captureArgs({ codec: "mp3", bitrate: 320, vbr: true });
    const lo = await captureArgs({ codec: "mp3", bitrate: 128, vbr: true });
    const qOf = (a: string[]): number => Number(a[a.indexOf("-q:a") + 1]);
    expect(qOf(hi)).toBeLessThan(qOf(lo));
  });

  it("uses -q:a for ogg (libvorbis) under vbr", async () => {
    const args = await captureArgs({ codec: "ogg", bitrate: 192, vbr: true });
    expect(args).toContain("libvorbis");
    expect(args).toContain("-q:a");
    expect(args).not.toContain("-b:a");
  });

  it("keeps the bitrate target but enables -vbr on for opus", async () => {
    const args = await captureArgs({ codec: "opus", bitrate: 128, vbr: true });
    expect(args).toContain("libopus");
    expect(args).toContain("-b:a");
    expect(args).toContain("-vbr");
    expect(args).toContain("on");
  });

  it("ignores the vbr flag for lossless flac (no -q:a quality target added)", async () => {
    const args = await captureArgs({ codec: "flac", bitrate: 1000, vbr: true });
    expect(args).toContain("flac");
    expect(args).toContain("-compression_level");
    expect(args).not.toContain("-q:a");
  });
});
