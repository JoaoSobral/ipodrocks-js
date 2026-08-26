/**
 * E2E — a rating already sitting in a file's own tag reaches iPodRocks
 * (issue #118).
 *
 * The report: a user rates tracks in Swinsian, which writes stars into the
 * FLAC tag. iPodRocks never read that tag, so the rating never appeared in
 * the library — and, separately, a rating synced down from an iPod never
 * appeared in Swinsian either. Per the maintainer's reply on the issue,
 * iPodRocks does not write back to the library and does not special-case any
 * one tool: it reads whichever rating tag the ecosystem already agrees on
 * (ID3 POPM, a Vorbis `RATING` comment, …), the same way Rockbox does, onto
 * the 0-10 scale both already share.
 *
 * Seeds a real FLAC via ffmpeg with a `RATING` Vorbis comment (the tag
 * Swinsian's own convention is closest to), so the tag is read exactly as it
 * would be in production. Skips when ffmpeg is unavailable.
 *
 * Run: npm run build && npx playwright test tests/e2e/rating-tag-import.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

type Track = { id: number; path: string; title: string; rating: number | null };

let launched: LaunchedApp;
let seedDir: string;
/** False when ffmpeg is unavailable — every test then skips rather than fails. */
let seeded = false;

/** A `RATING` Vorbis comment is a 0-100 percentage by the convention music-metadata assumes. */
function seedTrackWithRating(fileName: string, title: string, ratingPercent: number | null): boolean {
  const out = path.join(seedDir, fileName);
  const meta = ["-metadata", `title=${title}`, "-metadata", "artist=E2E Rating Artist", "-metadata", "album=E2E Rating Album"];
  if (ratingPercent !== null) meta.push("-metadata", `RATING=${ratingPercent}`);
  const res = spawnSync(
    "ffmpeg",
    ["-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1", ...meta, out],
    { encoding: "utf8" }
  );
  return res.status === 0 && fs.existsSync(out);
}

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

async function scanLibrary(window: Page): Promise<void> {
  await window.evaluate(async (folder) => {
    const api = (window as unknown as ApiWindow).api;
    await api.invoke("library:addFolder", {
      name: "E2E Rating Tag Seed",
      path: folder,
      contentType: "music",
    });
    await api.invoke("library:scan", {
      folders: [{ name: "E2E Rating Tag Seed", path: folder, contentType: "music" }],
    });
  }, seedDir);
}

async function libraryTracks(window: Page): Promise<Track[]> {
  return (await window.evaluate(() =>
    (window as unknown as ApiWindow).api.invoke("library:getTracks", { contentType: "music" })
  )) as Track[];
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-ratingtag-"));
  seeded = seedTrackWithRating("full.flac", "Full Stars", 100);
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  try {
    fs.rmSync(seedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("a rating tag already on disk is read into the library on first scan", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed a real rating tag");
  const window = await readyWindow();
  await scanLibrary(window);

  const tracks = await libraryTracks(window);
  const track = tracks.find((t) => t.title === "Full Stars");
  expect(track).toBeDefined();
  // RATING=100 -> music-metadata's 1.0 -> iPodRocks's 0-10 scale.
  expect(track?.rating).toBe(10);
});

test("an unrated file stays unrated, and a rescan never overwrites a rating set afterward", async () => {
  const half = seedTrackWithRating("half.flac", "Half Stars", 50);
  const none = seedTrackWithRating("none.flac", "No Rating", null);
  test.skip(!seeded || !half || !none, "ffmpeg unavailable — cannot seed real rating tags");

  const window = await readyWindow();
  await scanLibrary(window);

  let tracks = await libraryTracks(window);
  const halfTrack = tracks.find((t) => t.title === "Half Stars");
  const noneTrack = tracks.find((t) => t.title === "No Rating");
  expect(halfTrack?.rating).toBe(5);
  expect(noneTrack?.rating).toBeNull();

  // Something else (the app, a device sync) now rates the untagged track —
  // this must become the one source of truth.
  await window.evaluate(
    async (id) =>
      (window as unknown as ApiWindow).api.invoke("ratings:setTrackRating", id, 7),
    noneTrack!.id
  );

  // A rescan with nothing changed on disk must not touch it.
  await scanLibrary(window);
  tracks = await libraryTracks(window);
  expect(tracks.find((t) => t.title === "No Rating")?.rating).toBe(7);
});
