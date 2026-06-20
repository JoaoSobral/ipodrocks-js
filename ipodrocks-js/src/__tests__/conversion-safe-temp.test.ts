/**
 * @vitest-environment node
 *
 * Issue #82: mirroring the library 1:1 means conversion output paths can contain
 * spaces and parentheses (e.g. "Levels (2011)/track.mpc"), which external
 * encoders (mpcenc) and some ffmpeg builds mishandle. convertWithCodec now
 * encodes to an ASCII-safe temp path and moves the result to the real
 * destination with Node's fs.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", () => ({
  // sync-conversion imports { ChildProcess, spawn }; ChildProcess is a type only.
  spawn: spawnMock,
}));

// spawn is mocked, so the real binary is never invoked; just hand back a path.
vi.mock("../main/utils/ffmpeg-path", () => ({ getFfmpegPath: () => "ffmpeg" }));

// Wrap fs.renameSync in a spy so the EXDEV fallback can be exercised; everything
// else delegates to the real fs.
vi.mock("fs", async (importActual) => {
  const actual = await importActual<typeof import("fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

import {
  convertWithCodec,
  makeSafeConversionTempPath,
  moveConvertedFile,
} from "../main/sync/sync-conversion";

const SAFE_RE = /^[A-Za-z0-9_.-]+$/;

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-conv-"));
});

afterEach(() => {
  vi.clearAllMocks();
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("makeSafeConversionTempPath", () => {
  it("produces an ASCII-safe filename in the OS temp dir even for messy dests", () => {
    const tmp = makeSafeConversionTempPath("/dev/Avicii/Levels (2011)/01 - Levels.mpc");
    expect(path.dirname(tmp)).toBe(os.tmpdir());
    expect(SAFE_RE.test(path.basename(tmp))).toBe(true);
    expect(path.extname(tmp)).toBe(".mpc");
  });
});

describe("moveConvertedFile", () => {
  it("renames a finished file to a destination containing spaces and parens", () => {
    const from = path.join(workDir, "safe_tmp.mp3");
    const to = path.join(workDir, "Levels (2011)", "01 - Levels.mp3");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(from, "AUDIO");

    moveConvertedFile(from, to);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, "utf-8")).toBe("AUDIO");
  });

  it("falls back to copy+unlink when rename throws EXDEV (cross-filesystem)", () => {
    const from = path.join(workDir, "safe_tmp2.mp3");
    const to = path.join(workDir, "dest (x)", "out.mp3");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(from, "BYTES");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      const err = new Error("EXDEV") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });

    moveConvertedFile(from, to);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(to, "utf-8")).toBe("BYTES");
  });
});

describe("convertWithCodec — encodes via safe temp then moves to messy dest", () => {
  it("invokes the encoder with an ASCII-safe output path and lands the file at a paren/space dest", async () => {
    // Fake child process: write the encoder's output arg (last in argv) then close 0.
    let capturedOutputArg = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      capturedOutputArg = args[args.length - 1];
      fs.writeFileSync(capturedOutputArg, "ENCODED");
      setImmediate(() => proc.emit("close", 0));
      return proc;
    });

    const dest = path.join(workDir, "Avicii", "Levels (2011)", "01 - Levels.mp3");
    const ok = await convertWithCodec(
      "/library/Avicii/Levels (2011)/01 - Levels.flac",
      dest,
      { codec: "mp3", bitrate: 256 }
    );

    expect(ok).toBe(true);
    // Encoder never saw spaces/parens in its output arg.
    expect(path.dirname(capturedOutputArg)).toBe(os.tmpdir());
    expect(SAFE_RE.test(path.basename(capturedOutputArg))).toBe(true);
    // Final file is at the mirrored dest (with parens + spaces) and the temp is gone.
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, "utf-8")).toBe("ENCODED");
    expect(fs.existsSync(capturedOutputArg)).toBe(false);
  });

  it("cleans up the temp file and returns false when the encoder exits non-zero", async () => {
    let capturedOutputArg = "";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      capturedOutputArg = args[args.length - 1];
      fs.writeFileSync(capturedOutputArg, "PARTIAL");
      setImmediate(() => proc.emit("close", 1));
      return proc;
    });

    const dest = path.join(workDir, "Artist", "Album (2020)", "x.mp3");
    const ok = await convertWithCodec("/src/x.flac", dest, { codec: "mp3" });

    expect(ok).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(capturedOutputArg)).toBe(false);
  });
});
