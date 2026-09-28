/**
 * @vitest-environment node
 *
 * Regression — an ffmpeg child that never finishes wedged whoever awaited it.
 *
 * `player:prepare` and the Essentia decode both spawned ffmpeg with stdio left
 * as pipes nobody read, no timeout and no kill. A file whose metadata dump
 * outgrew the pipe (≈80 KiB of tags) blocked ffmpeg in `write(2)`: the
 * prepare never returned and left a process and a temp file per session; the
 * backfill parked mid-track, where `savant:backfillCancel` could not reach it,
 * and the same file was re-sampled — and wedged again — every later run.
 *
 * A FIFO with no writer is the stand-in for "a child that will never finish":
 * ffmpeg blocks opening it forever, exactly like one blocked on a full pipe,
 * and it needs no crafted media. The tag-flood file covers the original
 * trigger directly.
 *
 * Also here: the ffmpeg tag-dump parser, which used a regex that backtracked
 * cubically on a line of spaces, and ran on the main thread.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG: string = require("@ffmpeg-installer/ffmpeg").path;

vi.mock("../../main/utils/ffmpeg-path", () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  getFfmpegPath: () => require("@ffmpeg-installer/ffmpeg").path,
}));

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  seedLibraryFolder,
  seedTrack,
  type TestDb,
} from "../harness";
import {
  prepareTrack,
  cancelPrepare,
  getPlayerTempDir,
  setPlayerTranscodeTimeoutForTests,
  MAX_CONCURRENT_PLAYER_TRANSCODES,
} from "../../main/player/player-source";
import {
  analyzeAudioWithEssentia,
  setEssentiaTimeoutsForTests,
  setEssentiaWorkerScriptForTests,
} from "../../main/harmonic/essentia-analyzer";
import { parseFfmpegTagDump } from "../../main/sync/sync-conversion";
import { LibraryScanner } from "../../main/library/library-scanner";

const canFifo = process.platform !== "win32";
const itFifo = it.skipIf(!canFifo);

let dir: string;
let fifo: string;
let realMp3: string;
let taggedFlac: string;

function ffmpegChildrenOn(p: string): number {
  const r = spawnSync("pgrep", ["-f", p], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean).length;
}

function essentiaTempFiles(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("ipodrocks-essentia-"));
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-ffmpeg-bounded-"));
  if (canFifo) {
    fifo = path.join(dir, "never-ending.mp3");
    spawnSync("mkfifo", [fifo]);
  }
  realMp3 = path.join(dir, "real.mp3");
  spawnSync(FFMPEG, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:a", "libmp3lame", realMp3,
  ]);

  // ~200 KiB of distinct tags: at ffmpeg's default loglevel the input dump
  // alone is more than an unread pipe holds.
  const meta = [";FFMETADATA1"];
  for (let i = 0; i < 2000; i++) meta.push(`tag_${i}=${"v".repeat(90)}${i}`);
  const metaFile = path.join(dir, "meta.txt");
  fs.writeFileSync(metaFile, meta.join("\n") + "\n");
  taggedFlac = path.join(dir, "tag-flood.flac");
  const r = spawnSync(FFMPEG, [
    "-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=2",
    "-i", metaFile, "-map_metadata", "1", "-c:a", "flac", taggedFlac,
  ]);
  if (r.status !== 0) throw new Error(`fixture failed: ${r.stderr}`);

  const esbuild = await import("esbuild");
  const outfile = path.join(dir, "essentia-worker.js");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "../../main/harmonic/essentia-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  setEssentiaWorkerScriptForTests(outfile);
});

afterAll(() => {
  setEssentiaWorkerScriptForTests(null);
  setPlayerTranscodeTimeoutForTests(undefined);
  setEssentiaTimeoutsForTests({});
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("player:prepare transcode", () => {
  afterEach(async () => {
    setPlayerTranscodeTimeoutForTests(undefined);
    for (let i = 0; i <= MAX_CONCURRENT_PLAYER_TRANSCODES; i++) await cancelPrepare(`s${i}`);
  });

  it("finishes on a file whose metadata dump would overflow an unread pipe", async () => {
    const { strategy } = await prepareTrack({ path: taggedFlac, codec: "FLAC" }, true, "s0");
    expect(strategy).toBe("transcode");
  });

  itFifo("a transcode that never finishes is killed at the limit, its temp file removed", async () => {
    setPlayerTranscodeTimeoutForTests(400);
    const before = fs.existsSync(getPlayerTempDir()) ? fs.readdirSync(getPlayerTempDir()) : [];
    const started = Date.now();
    await expect(prepareTrack({ path: fifo, codec: "MP3" }, true, "s0")).rejects.toThrow(
      /did not finish/
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fs.readdirSync(getPlayerTempDir()).filter((f) => !before.includes(f))).toEqual([]);
    expect(await waitFor(() => ffmpegChildrenOn(fifo) === 0)).toBe(true);
  });

  itFifo("concurrent transcodes are bounded server-wide, not per session", async () => {
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_PLAYER_TRANSCODES; i++) {
      pending.push(prepareTrack({ path: fifo, codec: "MP3" }, true, `s${i}`).catch(() => {}));
    }
    await waitFor(() => ffmpegChildrenOn(fifo) >= MAX_CONCURRENT_PLAYER_TRANSCODES);
    await expect(
      prepareTrack({ path: fifo, codec: "MP3" }, true, `s${MAX_CONCURRENT_PLAYER_TRANSCODES}`)
    ).rejects.toThrow(/busy/);
    for (let i = 0; i < MAX_CONCURRENT_PLAYER_TRANSCODES; i++) await cancelPrepare(`s${i}`);
    await Promise.all(pending);
    expect(await waitFor(() => ffmpegChildrenOn(fifo) === 0)).toBe(true);
  });
});

describe("Essentia analysis", () => {
  afterEach(() => setEssentiaTimeoutsForTests({}));

  itFifo("cancelling interrupts a stuck decode: prompt return, no child, no temp WAV", async () => {
    const before = essentiaTempFiles();
    const ac = new AbortController();
    const started = Date.now();
    const pending = analyzeAudioWithEssentia(fifo, { signal: ac.signal });
    await waitFor(() => ffmpegChildrenOn(fifo) > 0);
    ac.abort();
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await waitFor(() => ffmpegChildrenOn(fifo) === 0)).toBe(true);
    expect(essentiaTempFiles().filter((f) => !before.includes(f))).toEqual([]);
  });

  itFifo("a decode that never finishes times out instead of wedging", async () => {
    setEssentiaTimeoutsForTests({ decodeMs: 300 });
    expect(await analyzeAudioWithEssentia(fifo)).toBeNull();
    expect(await waitFor(() => ffmpegChildrenOn(fifo) === 0)).toBe(true);
  });

  it("an analysis over its time limit is abandoned, and the next track gets a fresh worker", async () => {
    setEssentiaTimeoutsForTests({ analysisMs: 1 });
    expect(await analyzeAudioWithEssentia(realMp3)).toBeNull();
    setEssentiaTimeoutsForTests({});
    expect(await analyzeAudioWithEssentia(realMp3)).not.toBeNull();
  }, 60_000);

  it("the WASM runs off the main thread: timers keep firing during an analysis", async () => {
    let ticks = 0;
    let worstGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
      ticks++;
    }, 10);
    try {
      expect(await analyzeAudioWithEssentia(realMp3)).not.toBeNull();
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    // Generous: a main-thread analysis blocks for the whole extractor run.
    expect(worstGap).toBeLessThan(500);
  }, 60_000);
});

describe.skipIf(!canRunDbTests || !canFifo)("Essentia backfill", () => {
  let db: TestDb;
  afterEach(() => {
    setEssentiaTimeoutsForTests({});
    closeDb(db);
  });

  it("marks a track that times out so later runs do not sample it again", async () => {
    db = createTestDb();
    const folderId = seedLibraryFolder(db, { name: "Music", path: dir, contentType: "music" });
    const stuck = seedTrack(db, { path: fifo, title: "stuck", libraryFolderId: folderId });
    setEssentiaTimeoutsForTests({ decodeMs: 300 });

    const scanner = new LibraryScanner(db);
    expect(await scanner.backfillFeaturesWithEssentia(100)).toBe(0);
    const row = db.prepare("SELECT features_scanned, camelot FROM tracks WHERE id = ?").get(stuck) as {
      features_scanned: number;
      camelot: string | null;
    };
    expect(row.camelot).toBeNull();
    expect(row.features_scanned).toBe(2);

    // Second run: nothing to sample, so it returns without spawning anything.
    const progress: unknown[] = [];
    await scanner.backfillFeaturesWithEssentia(100, (p) => progress.push(p));
    expect(progress).toEqual([]);
  });

  it("cancel stops the run mid-track, and the interrupted track is not marked", async () => {
    db = createTestDb();
    const folderId = seedLibraryFolder(db, { name: "Music", path: dir, contentType: "music" });
    const stuck = seedTrack(db, { path: fifo, title: "stuck", libraryFolderId: folderId });

    const ac = new AbortController();
    const scanner = new LibraryScanner(db);
    const started = Date.now();
    const run = scanner.backfillFeaturesWithEssentia(100, undefined, ac.signal);
    await waitFor(() => ffmpegChildrenOn(fifo) > 0);
    ac.abort();
    await run;
    expect(Date.now() - started).toBeLessThan(5000);
    const row = db.prepare("SELECT features_scanned FROM tracks WHERE id = ?").get(stuck) as {
      features_scanned: number;
    };
    expect(row.features_scanned).toBe(0);
    expect(await waitFor(() => ffmpegChildrenOn(fifo) === 0)).toBe(true);
  });
});

describe("parseFfmpegTagDump", () => {
  it("is linear on the line that used to backtrack cubically", () => {
    const evil = " ".repeat(1004) + "!";
    const started = performance.now();
    expect(parseFfmpegTagDump(evil)).toEqual({});
    // A MiB of them — the most spawnSync's buffer would hand over.
    const flood = Array.from({ length: Math.ceil((1024 * 1024) / evil.length) }, () => evil).join("\n");
    expect(parseFfmpegTagDump(flood)).toEqual({});
    const noColon = " ".repeat(1004) + "a".repeat(20);
    expect(parseFfmpegTagDump(Array(1000).fill(noColon).join("\n"))).toEqual({});
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("still reads the metadata block of a real dump", () => {
    const dump = [
      "Input #0, flac, from 'x.flac':",
      "  Metadata:",
      "    REPLAYGAIN_TRACK_GAIN: -3.38 dB",
      "    title           : Some: Title",
      "    bad!key         : dropped",
      "  Duration: 00:00:01.00, start: 0.000000, bitrate: 10 kb/s",
      "    Stream #0:0: Audio: flac, 44100 Hz, mono, s16",
      "    REPLAYGAIN_TRACK_GAIN: second value ignored",
    ].join("\r\n");
    expect(parseFfmpegTagDump(dump)).toEqual({
      REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
      title: "Some: Title",
    });
  });
});
