/**
 * @vitest-environment node
 *
 * The lossless check end to end, below the IPC layer: real files made by
 * ffmpeg, the real `LibraryScanner`, the real decode (`decodePcmF32`), the real
 * Essentia worker (bundled from source, as `ffmpeg-bounded-children` does) and
 * the real verdict, written to a real database. Then the two things that must
 * not regress once verdicts exist:
 *
 * - **A replaced file loses its verdict.** The scanner's upsert clears the
 *   `lossless_*` columns (and any "mark as OK") when size or hash changes —
 *   otherwise a user who swapped a fake for a real rip would keep seeing it
 *   flagged, and one who swapped the other way would keep their OK.
 * - **Delete is contained.** It takes ids, deletes only rows whose stored
 *   verdict is flagged and not overruled, never a genuine track's file, and
 *   removes the rows through the scan's own cleanup so no dependent row
 *   (`playlist_items`, here) is orphaned.
 *
 * Skips when the system has no ffmpeg with libmp3lame to *make* the fixtures
 * (the app's own decode uses the bundled ffmpeg).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canRunDbTests, createTestDb, seedLibraryFolder, seedPlaylist, type TestDb } from "../harness";
import { LibraryScanner } from "../../main/library/library-scanner";
import { getLosslessReport, runLosslessScan, setLosslessOverride } from "../../main/lossless/lossless-scan";
import { deleteFlaggedLosslessTracks } from "../../main/lossless/lossless-delete";
import { setEssentiaWorkerScriptForTests } from "../../main/harmonic/essentia-analyzer";
import type { LosslessProgress, LosslessVerdict } from "../../shared/types";

function ffmpeg(args: string[]): boolean {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  return r.status === 0;
}

const NOISE = "anoisesrc=color=pink:r=44100:a=0.3:d=25,volume='0.6+0.4*sin(2*PI*t*0.5)':eval=frame";

let dir = "";
let workerDir = "";
let fixturesOk = false;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-lossless-"));
  workerDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-lossless-worker-"));
  const tmp = (n: string) => path.join(workerDir, n);
  const at = (n: string) => path.join(dir, n);
  fixturesOk =
    ffmpeg(["-f", "lavfi", "-i", NOISE, "-ac", "2", "-metadata", "title=Genuine", "-metadata", "album=Real Album", at("genuine.flac")]) &&
    ffmpeg(["-i", at("genuine.flac"), "-c:a", "libmp3lame", "-b:a", "128k", tmp("t128.mp3")]) &&
    ffmpeg(["-i", tmp("t128.mp3"), "-metadata", "title=Fake 128", "-metadata", "album=Fake Album", at("fake128.flac")]) &&
    ffmpeg(["-i", at("genuine.flac"), "-c:a", "aac", "-b:a", "128k", tmp("t.m4a")]) &&
    ffmpeg(["-i", tmp("t.m4a"), "-c:a", "alac", "-metadata", "title=Fake AAC", at("fakeaac.m4a")]) &&
    ffmpeg(["-f", "lavfi", "-i", "anoisesrc=color=pink:r=44100:a=0.00005:d=25", "-metadata", "title=Quiet", at("quiet.flac")]) &&
    // A real lossy file is not a lossless check candidate at all.
    ffmpeg(["-i", at("genuine.flac"), "-c:a", "libmp3lame", "-b:a", "192k", "-metadata", "title=Plain MP3", at("plain.mp3")]);

  const esbuild = await import("esbuild");
  const outfile = path.join(workerDir, "essentia-worker.js");
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "../../main/harmonic/essentia-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  setEssentiaWorkerScriptForTests(outfile);
}, 120_000);

afterAll(() => {
  setEssentiaWorkerScriptForTests(null);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (workerDir) fs.rmSync(workerDir, { recursive: true, force: true });
});

function verdictOf(db: TestDb, file: string): LosslessVerdict | null {
  const row = db.prepare("SELECT lossless_verdict FROM tracks WHERE path = ?").get(path.join(dir, file)) as
    | { lossless_verdict: LosslessVerdict | null }
    | undefined;
  return row ? row.lossless_verdict : null;
}

function idOf(db: TestDb, file: string): number {
  return (db.prepare("SELECT id FROM tracks WHERE path = ?").get(path.join(dir, file)) as { id: number }).id;
}

describe.skipIf(!canRunDbTests)("lossless check — real files, real worker, real database", () => {
  let db: TestDb;

  beforeAll(async () => {
    if (!fixturesOk) return;
    db = createTestDb();
    seedLibraryFolder(db, { name: "Music", path: dir, contentType: "music" });
    await new LibraryScanner(db).scanFolder(dir, "music", undefined, undefined, { scanHarmonicData: false });
  }, 120_000);

  it("tells a lossy transcode from the real thing, and never touches a lossy file", async (ctx) => {
    if (!fixturesOk) ctx.skip();
    const progress: LosslessProgress[] = [];
    const result = await runLosslessScan(db, { scope: "unchecked", deep: true }, (p) => progress.push(p), new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.checked).toBe(4); // the .mp3 is not a candidate
    expect(verdictOf(db, "genuine.flac")).toBe("genuine");
    expect(verdictOf(db, "fake128.flac")).toBe("lossy_strong");
    expect(["lossy_strong", "lossy"]).toContain(verdictOf(db, "fakeaac.m4a"));
    expect(verdictOf(db, "quiet.flac")).toBe("inconclusive");
    expect(verdictOf(db, "plain.mp3")).toBeNull();

    // Both passes reported, and the run finished.
    expect(progress.some((p) => p.phase === "light")).toBe(true);
    expect(progress.some((p) => p.phase === "deep")).toBe(true);
    expect(progress.at(-1)?.phase).toBe("complete");

    const report = getLosslessReport(db);
    const fake = report.find((r) => r.path.endsWith("fake128.flac"))!;
    expect(fake.stage).toBe("deep");
    expect(fake.cutoffHz).toBeGreaterThan(14000);
    expect(fake.cutoffHz).toBeLessThan(17000);
    expect(fake.source).toMatch(/MP3/);
    expect(fake.album).toBe("Fake Album");
    expect(fake.emptyShare).toBeGreaterThan(0.95);
  }, 180_000);

  it("a second 'unchecked' run has nothing left to do", async (ctx) => {
    if (!fixturesOk) ctx.skip();
    const r = await runLosslessScan(db, { scope: "unchecked" }, () => {}, new AbortController().signal);
    expect(r.checked).toBe(0);
  });

  it("a track marked OK is skipped by a full re-check and cannot be deleted", async (ctx) => {
    if (!fixturesOk) ctx.skip();
    const aac = idOf(db, "fakeaac.m4a");
    setLosslessOverride(db, [aac], true);
    const r = await runLosslessScan(db, { scope: "all", deep: false }, () => {}, new AbortController().signal);
    expect(r.checked).toBe(3);
    const out = await deleteFlaggedLosslessTracks(db, [aac]);
    expect(out.deleted).toBe(0);
    expect(fs.existsSync(path.join(dir, "fakeaac.m4a"))).toBe(true);
    setLosslessOverride(db, [aac], false);
  }, 180_000);

  it("deletes only flagged files, by id, with the scan's full cleanup", async (ctx) => {
    if (!fixturesOk) ctx.skip();
    // The previous test left the light pass's verdicts; put the deep ones back.
    await runLosslessScan(db, { scope: "all" }, () => {}, new AbortController().signal);
    const fakeId = idOf(db, "fake128.flac");
    const genuineId = idOf(db, "genuine.flac");
    const playlistId = seedPlaylist(db, { name: "Mixed", trackIds: [fakeId, genuineId] });

    // A genuine id, a bogus id and a non-integer ride along; only the flagged one goes.
    const out = await deleteFlaggedLosslessTracks(db, [fakeId, genuineId, 999999, 1.5 as number]);
    expect(out.deleted).toBe(1);
    expect(out.failed).toEqual([]);
    // The Node host (no IPODROCKS desktop) has no trash: permanent.
    expect(out.permanent + out.trashed).toBe(1);

    expect(fs.existsSync(path.join(dir, "fake128.flac"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "genuine.flac"))).toBe(true);
    expect(db.prepare("SELECT 1 FROM tracks WHERE id = ?").get(fakeId)).toBeUndefined();
    const items = db.prepare("SELECT track_id FROM playlist_items WHERE playlist_id = ?").all(playlistId) as { track_id: number }[];
    expect(items.map((i) => i.track_id)).toEqual([genuineId]);
  }, 180_000);

  it("a replaced file loses its verdict on the next library scan", async (ctx) => {
    if (!fixturesOk) ctx.skip();
    const aac = idOf(db, "fakeaac.m4a");
    setLosslessOverride(db, [aac], true);
    expect(verdictOf(db, "fakeaac.m4a")).not.toBeNull();
    // Swap in different audio under the same name, with a later mtime.
    fs.copyFileSync(path.join(dir, "quiet.flac"), path.join(workerDir, "swap.flac"));
    expect(ffmpeg(["-i", path.join(dir, "genuine.flac"), "-t", "10", "-c:a", "alac", path.join(workerDir, "swap.m4a")])).toBe(true);
    fs.copyFileSync(path.join(workerDir, "swap.m4a"), path.join(dir, "fakeaac.m4a"));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "fakeaac.m4a"), later, later);

    await new LibraryScanner(db).scanFolder(dir, "music", undefined, undefined, { scanHarmonicData: false });
    const row = db.prepare("SELECT lossless_verdict, lossless_override FROM tracks WHERE id = ?").get(aac) as {
      lossless_verdict: string | null;
      lossless_override: number;
    };
    expect(row.lossless_verdict).toBeNull();
    expect(row.lossless_override).toBe(0);
    // An untouched file keeps its verdict through the same scan.
    expect(verdictOf(db, "genuine.flac")).toBe("genuine");
  }, 180_000);
});
