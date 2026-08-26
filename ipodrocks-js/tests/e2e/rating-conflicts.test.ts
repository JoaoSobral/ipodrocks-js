/**
 * E2E — what a first sync does to your ratings, and how you answer the
 * conflicts it does raise (issue #117 follow-up).
 *
 * Once path matching was fixed the reporter's device started matching all 2411
 * of its runtime records, which exposed two things that had been unreachable
 * while nothing matched at all. Rockbox has no null rating — 0 is how it says
 * "unrated" — and reading that 0 as a value meant a first sync queued one
 * conflict per track the user had rated in iPodRocks and not on the player.
 * Separately, the rebuild warning measured how many of the device's ratings
 * read 0, which on any normal library is nearly all of them, so it fired every
 * sync and claimed to have skipped an import that had in fact already run.
 *
 * Drives the real built app through real channels only, including a real sync,
 * and answers the conflicts through the actual UI. Seed folders live under the
 * user's home dir (main-process path allowlist).
 *
 * The merge and the rebuild verdict are pinned case by case in
 * src/__tests__/regressions/rating-zero-and-rebuild.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/rating-conflicts.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import {
  writeTcdFixture,
  type TcdFixtureTrack,
} from "../../src/__tests__/harness/tcd-fixture";

interface Api {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
}
interface ApiWindow {
  api: Api;
}

let launched: LaunchedApp;
let rootDir: string;
let libraryDir: string;
let deviceDir: string;

const DEVICE_NAME = "E2E Ratings iPod";
const ARTIST = "Rating Artist";
const ALBUM = "Rating Album";
const TITLES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];

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

function call<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    async ([c, a]) =>
      (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

/** Library files plus the folders Rockbox expects on the device. */
function seedFiles(): void {
  const albumDir = path.join(libraryDir, ARTIST, ALBUM);
  fs.mkdirSync(albumDir, { recursive: true });
  for (const title of TITLES) {
    fs.writeFileSync(path.join(albumDir, `${title}.flac`), Buffer.alloc(4096));
  }
  for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(deviceDir, folder), { recursive: true });
  }
}

interface TrackRow {
  id: number;
  title: string;
  rating: number | null;
}

async function libraryTracks(window: Page): Promise<TrackRow[]> {
  const tracks = await call<TrackRow[]>(window, "library:getTracks", {
    contentType: "music",
  });
  return tracks;
}

/** Scan, register the device, and sync so the files really are on it. */
async function setUpSynced(window: Page): Promise<number> {
  await call(window, "library:scan", {
    folders: [{ name: "E2E Ratings", path: libraryDir, contentType: "music" }],
  });
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });
  await runSync(window, device.id);
  return device.id;
}

/** Run a full music sync and return every log line it emitted. */
async function runSync(window: Page, deviceId: number): Promise<string[]> {
  return window.evaluate(async (id) => {
    const api = (window as unknown as ApiWindow).api;
    const logs: string[] = [];
    const unsub = api.on("sync:progress", (...args: unknown[]) => {
      const p = args[args.length - 1] as { event?: string; message?: string };
      if (p?.event === "log" && p.message) logs.push(p.message);
    });
    await api.invoke("sync:start", {
      deviceId: id,
      syncType: "full",
      extraTrackPolicy: "keep",
      preserveFolderStructure: true,
      albumGrouping: "album-artist",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });
    unsub();
    return logs;
  }, deviceId);
}

/** Plant a Rockbox database describing the synced files. */
function fixture(ratings: Record<string, number>): void {
  const tracks: TcdFixtureTrack[] = TITLES.map((title, i) => ({
    path: `/<HDD0>/Music/${ARTIST}/${ALBUM}/${title}.flac`,
    playCount: i + 1,
    playTimeMs: (i + 1) * 200_000,
    lengthMs: 200_000,
    rating: ratings[title] ?? 0,
    lastPlayedSerial: i + 1,
  }));
  writeTcdFixture(deviceDir, tracks);
}

interface ConflictRow {
  id: number;
  title: string;
  reported_rating: number;
  canonical_rating: number | null;
}

const conflicts = (window: Page): Promise<ConflictRow[]> =>
  call<ConflictRow[]>(window, "ratings:getConflicts");

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-ratings-"));
  libraryDir = path.join(rootDir, "library");
  deviceDir = path.join(rootDir, "device");
  fs.mkdirSync(libraryDir, { recursive: true });
  fs.mkdirSync(deviceDir, { recursive: true });
  seedFiles();
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("a device with no ratings of its own leaves the library's alone", async () => {
  const window = await readyWindow();
  const deviceId = await setUpSynced(window);

  // Rated in iPodRocks, never rated on the player — the reporter's situation.
  const tracks = await libraryTracks(window);
  for (const t of tracks.slice(0, 3)) {
    await call(window, "ratings:setTrackRating", t.id, 10);
  }

  // Every track reads 0 on the device, because none was ever rated there.
  fixture({});
  const logs = await runSync(window, deviceId);

  // Nothing to answer: a 0 from the device is the absence of an opinion, not a
  // disagreement. This was one conflict per rated track.
  expect(await conflicts(window)).toEqual([]);

  // And nothing was quietly overwritten: the three keep their rating and the
  // other two stay unrated rather than being written down as "rated zero".
  const after = await libraryTracks(window);
  expect(after.filter((t) => t.rating === 10)).toHaveLength(3);
  expect(after.filter((t) => t.rating === null)).toHaveLength(2);

  // The warning measured "how much of this library is unrated", so it fired on
  // every sync of every normal library.
  expect(logs.join("\n")).not.toMatch(/looks rebuilt/i);
});

test("a device that really lost its ratings is caught, and nothing is imported", async () => {
  const window = await readyWindow();
  const deviceId = await setUpSynced(window);

  // First sync: the device holds ratings, and they are adopted.
  fixture({ Alpha: 10, Beta: 8, Gamma: 8, Delta: 6, Epsilon: 6 });
  await runSync(window, deviceId);
  expect(
    (await libraryTracks(window)).filter((t) => t.rating !== null)
  ).toHaveLength(5);

  // Then Database → Initialize Now on the device: every rating gone.
  fixture({});
  const logs = await runSync(window, deviceId);

  expect(logs.join("\n")).toMatch(/looks rebuilt/i);
  // The message used to say the ratings were skipped while the merge had
  // already run. They must actually still be there.
  const after = await libraryTracks(window);
  expect(after.filter((t) => t.rating !== null)).toHaveLength(5);
  expect(await conflicts(window)).toEqual([]);
});

test("a genuine disagreement is still raised, and can be answered for all at once", async () => {
  const window = await readyWindow();
  const deviceId = await setUpSynced(window);

  const tracks = await libraryTracks(window);
  for (const t of tracks) {
    await call(window, "ratings:setTrackRating", t.id, 10);
  }

  // The device disagrees on three of them, by more than the half-step the
  // merge tolerates silently.
  fixture({ Alpha: 2, Beta: 2, Gamma: 2, Delta: 10, Epsilon: 10 });
  await runSync(window, deviceId);

  const open = await conflicts(window);
  expect(open).toHaveLength(3);

  // Answer them through the UI, the way the user does. The panel counts the
  // conflicts when it mounts, and these were raised by a sync driven straight
  // over IPC afterwards, so reload to get the state a user would actually see.
  await window.reload();
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  const libraryNav = window
    .locator('[data-panel="library"], [data-testid="nav-library"], button:has-text("Library")')
    .first();
  if (await libraryNav.isVisible()) await libraryNav.click();

  await window.locator('button:has-text("Resolve →")').first().click({ timeout: 15_000 });
  const dialog = window.getByRole("dialog").filter({ hasText: "Rating Conflicts" });
  await dialog.waitFor({ timeout: 10_000 });

  // Without the tick, one press answers one track.
  await dialog.locator('button:has-text("Keep Library")').first().click();
  await expect(dialog.locator('button:has-text("Keep Library")')).toHaveCount(2);

  // With it, one press answers the rest.
  await dialog.locator('[data-testid="rating-conflicts-apply-all"] input').check();
  await dialog.locator('button:has-text("Keep Library (all 2)")').first().click();
  await expect(dialog.getByText("No rating conflicts — all resolved.")).toBeVisible();

  expect(await conflicts(window)).toEqual([]);
  // "Keep Library" means the library's rating survived every one of them.
  expect(
    (await libraryTracks(window)).filter((t) => t.rating === 10)
  ).toHaveLength(5);
});

test("Starred collects every rated track without any play history", async () => {
  const window = await readyWindow();
  await call(window, "library:scan", {
    folders: [{ name: "E2E Ratings", path: libraryDir, contentType: "music" }],
  });

  const types = await call<{
    types: Array<{ value: string; available?: boolean }>;
  }>(window, "genius:types");
  const starred = types.types.find((t) => t.value === "starred");
  // Reads ratings, not counters, so it must be offered on a library that has
  // never been near a device.
  expect(starred?.available).not.toBe(false);

  const tracks = await libraryTracks(window);
  await call(window, "ratings:setTrackRating", tracks[0].id, 2);
  await call(window, "ratings:setTrackRating", tracks[1].id, 10);
  await call(window, "ratings:setTrackRating", tracks[2].id, 6);
  // Explicitly cleared on the device reads as 0, which is not a star.
  await call(window, "ratings:setTrackRating", tracks[3].id, 0);

  const playlist = await call<{
    tracks: Array<{ title: string; rating: number | null }>;
  }>(window, "genius:generate", null, "starred", {});

  expect(playlist.tracks.map((t) => t.title)).toEqual([
    tracks[1].title,
    tracks[2].title,
    tracks[0].title,
  ]);

  // Top Rated stays what it was — the best of them, not all of them.
  const top = await call<{ tracks: Array<{ title: string }> }>(
    window,
    "genius:generate",
    null,
    "top_rated",
    {}
  );
  expect(top.tracks.map((t) => t.title)).toEqual([tracks[1].title]);
});
