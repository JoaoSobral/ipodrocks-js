/**
 * E2E — the "Library tags always win" setting (issue #118 follow-up).
 *
 * Off by default: a rating tag only ever seeds a track nothing has rated yet
 * (see rating-tag-import.test.ts). This setting, in Settings → Ratings, lets
 * the user flip that around — the next scan makes the file's tag win for
 * every track, including clearing one the file leaves untagged, as a
 * deliberate "reset iPodRocks to match my library manager" action.
 *
 * Drives the real Settings panel UI (not just the IPC channel) to prove the
 * checkbox actually reaches the scan, seeding real FLACs via ffmpeg. Skips
 * when ffmpeg is unavailable.
 *
 * Run: npm run build && npx playwright test tests/e2e/rating-tag-always-wins.test.ts
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
let seeded = false;

function seedTrackWithRating(fileName: string, title: string, ratingPercent: number | null): boolean {
  const out = path.join(seedDir, fileName);
  const meta = ["-metadata", `title=${title}`, "-metadata", "artist=E2E Always Wins Artist", "-metadata", "album=E2E Always Wins Album"];
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
      name: "E2E Always Wins Seed",
      path: folder,
      contentType: "music",
    });
    await api.invoke("library:scan", {
      folders: [{ name: "E2E Always Wins Seed", path: folder, contentType: "music" }],
    });
  }, seedDir);
}

async function libraryTracks(window: Page): Promise<Track[]> {
  return (await window.evaluate(() =>
    (window as unknown as ApiWindow).api.invoke("library:getTracks", { contentType: "music" })
  )) as Track[];
}

/** The row is a `<p>` label as a sibling of the Switch inside one flex row. */
function ratingsAlwaysWinSwitch(window: Page) {
  return window
    .locator("div.flex.items-start.justify-between", { hasText: "Library tags always win" })
    .getByRole("switch");
}

async function setTagRatingAlwaysWins(window: Page, enabled: boolean): Promise<void> {
  await window.getByRole("button", { name: "Settings" }).click();
  const toggle = ratingsAlwaysWinSwitch(window);
  await toggle.waitFor({ timeout: 10_000 });
  const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
  if (isChecked !== enabled) await toggle.click();
  await window.getByRole("button", { name: "Save", exact: true }).click();
  await window.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10_000 });
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-alwayswins-"));
  seeded = seedTrackWithRating("tagged.flac", "Tagged Track", 20); // 20% -> internal 2
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

test("off by default: turning it on and rescanning overwrites a rating set since the last scan", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed a real rating tag");
  const window = await readyWindow();
  await scanLibrary(window);

  let tracks = await libraryTracks(window);
  const track = tracks.find((t) => t.title === "Tagged Track");
  expect(track?.rating).toBe(2);

  // Something else (a device sync, an in-app edit) rates it differently.
  await window.evaluate(
    async (id) => (window as unknown as ApiWindow).api.invoke("ratings:setTrackRating", id, 9),
    track!.id
  );
  tracks = await libraryTracks(window);
  expect(tracks.find((t) => t.title === "Tagged Track")?.rating).toBe(9);

  await setTagRatingAlwaysWins(window, true);
  await scanLibrary(window);

  tracks = await libraryTracks(window);
  expect(tracks.find((t) => t.title === "Tagged Track")?.rating).toBe(2);
});

test("turning it back off restores the normal seed-only behavior", async () => {
  test.skip(!seeded, "ffmpeg unavailable — cannot seed a real rating tag");
  const window = await readyWindow();
  await scanLibrary(window);

  await setTagRatingAlwaysWins(window, true);
  await setTagRatingAlwaysWins(window, false);

  let tracks = await libraryTracks(window);
  const track = tracks.find((t) => t.title === "Tagged Track");
  await window.evaluate(
    async (id) => (window as unknown as ApiWindow).api.invoke("ratings:setTrackRating", id, 4),
    track!.id
  );

  await scanLibrary(window);
  tracks = await libraryTracks(window);
  expect(tracks.find((t) => t.title === "Tagged Track")?.rating).toBe(4);
});
