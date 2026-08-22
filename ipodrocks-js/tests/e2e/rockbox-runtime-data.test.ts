/**
 * E2E — importing the runtime data Rockbox records on the device.
 *
 * This is coverage the old playback.log path could never have. There was no way
 * to produce a device that had genuinely recorded plays, so
 * `listening-stats.test.ts` states outright that it can only assert the empty
 * case. Runtime data lives in a fixed-layout binary file, so a fixture can
 * build one — and the whole loop becomes reachable: scan a library, register a
 * device holding the same files, plant a Rockbox database with counters in it,
 * and import over IPC.
 *
 * Drives the real built app (renderer → preload → main → SQLite → filesystem)
 * through real channels only. Seed folders live under the user's home dir
 * (main-process path allowlist).
 *
 * The rating write-back is covered byte-for-byte in
 * src/__tests__/behaviors/tcd-format.test.ts and end-to-end through the sync
 * phases in src/__tests__/behaviors/rating-writeback.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/rockbox-runtime-data.test.ts
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

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

let launched: LaunchedApp;
let deviceDir: string;
let libraryDir: string;

const DEVICE_NAME = "E2E Runtime iPod";
const ARTIST = "Runtime Artist";
const ALBUM = "Runtime Album";
const FILES = ["01 - Alpha.mp3", "02 - Beta.mp3", "03 - Gamma.mp3"];
/** Identical bytes in both places, so the device check matches on name+size. */
const CONTENT = "x".repeat(4096);

function rockboxPath(file: string): string {
  return `/<HDD0>/Music/${ARTIST}/${ALBUM}/${file}`;
}

/** Plant the same three files in the library folder and on the device. */
function seedFiles(): void {
  const libAlbum = path.join(libraryDir, ARTIST, ALBUM);
  fs.mkdirSync(libAlbum, { recursive: true });
  for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(deviceDir, folder), { recursive: true });
  }
  const devAlbum = path.join(deviceDir, "Music", ARTIST, ALBUM);
  fs.mkdirSync(devAlbum, { recursive: true });

  for (const file of FILES) {
    fs.writeFileSync(path.join(libAlbum, file), CONTENT);
    fs.writeFileSync(path.join(devAlbum, file), CONTENT);
  }
}

/** Write a Rockbox database describing the three device files. */
function fixture(
  tracks: Partial<TcdFixtureTrack>[],
  serial?: number
): number[] {
  return writeTcdFixture(
    deviceDir,
    FILES.map((file, i) => ({ path: rockboxPath(file), ...tracks[i] })),
    serial === undefined ? {} : { serial }
  );
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

function call<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    async ([c, a]) =>
      (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

/**
 * Scan the library, register the device, and run a device check.
 *
 * `devMode` bypasses the mount-point test so a plain folder counts as a
 * connected device; the check is what records where each track sits on it,
 * which is what lets Rockbox's records be matched exactly.
 */
async function setUp(window: Page): Promise<number> {
  await call(window, "library:scan", {
    folders: [{ name: "E2E Runtime", path: libraryDir, contentType: "music" }],
  });
  const device = await call<{ id: number }>(window, "device:add", {
    name: DEVICE_NAME,
    mountPath: deviceDir,
    devMode: true,
  });
  await call(window, "device:check", device.id);
  return device.id;
}

interface ImportResult {
  imported: number;
  unmatched: number;
  newPlays: number;
  reason: string | null;
}

test.beforeEach(async () => {
  const home = os.homedir();
  deviceDir = fs.mkdtempSync(path.join(home, ".ipr-e2e-rtdev-"));
  libraryDir = fs.mkdtempSync(path.join(home, ".ipr-e2e-rtlib-"));
  seedFiles();
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  for (const dir of [deviceDir, libraryDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("a device with no Rockbox database is reported, not treated as an error", async () => {
  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.imported).toBe(0);
  expect(res.reason).toMatch(/Initialize Now/);
});

test("a database with nothing recorded points at the Rockbox setting", async () => {
  fixture([{}, {}, {}], 0);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.imported).toBe(0);
  expect(res.reason).toMatch(/Gather Runtime Data/);
});

test("play counts and listening time import and roll up into the stats", async () => {
  fixture([
    { playCount: 6, playTimeMs: 1_200_000, lengthMs: 200_000, rating: 8, lastPlayedSerial: 2 },
    { playCount: 1, playTimeMs: 100_000, lengthMs: 200_000, lastPlayedSerial: 1 },
    // Never played — imports as zero, which is not an error and not a gap.
    {},
  ]);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.reason).toBeNull();
  expect(res.imported).toBe(3);
  expect(res.unmatched).toBe(0);

  const stats = await call<{
    totalPlays: number;
    totalListeningTimeMs: number;
    uniqueTracksPlayed: number;
  }>(window, "genius:getListeningStats", "all");

  expect(stats.totalPlays).toBe(7);
  expect(stats.totalListeningTimeMs).toBe(1_300_000);
  // The unplayed track imported, but contributes nothing.
  expect(stats.uniqueTracksPlayed).toBe(2);
});

test("counters unlock the Genius types that need them", async () => {
  const window = await readyWindow();
  const deviceId = await setUp(window);

  const before = await call<{
    types: Array<{ value: string; available?: boolean }>;
  }>(window, "genius:types");
  expect(
    before.types.find((t) => t.value === "most_played")?.available
  ).toBe(false);

  fixture([
    { playCount: 4, playTimeMs: 800_000, lengthMs: 200_000 },
    {},
    {},
  ]);
  await call(window, "device:readRuntimeData", deviceId);

  const after = await call<{
    types: Array<{ value: string; available?: boolean }>;
    tracksWithPlays: number;
  }>(window, "genius:types");
  expect(after.tracksWithPlays).toBe(1);
  expect(after.types.every((t) => t.available !== false)).toBe(true);

  // genius:generate takes (deviceId, type, opts); the device argument is
  // vestigial now that everything is read from the database.
  const playlist = await call<{ tracks: Array<{ title: string; playCount: number }> }>(
    window,
    "genius:generate",
    null,
    "most_played",
    {}
  );
  expect(playlist.tracks.length).toBe(1);
  expect(playlist.tracks[0].playCount).toBe(4);
});

test("a second import dates the plays it sees appear, and re-importing changes nothing", async () => {
  fixture([{ playCount: 1, playTimeMs: 200_000, lengthMs: 200_000 }, {}, {}]);

  const window = await readyWindow();
  const deviceId = await setUp(window);

  const monthPlays = async () =>
    (await call<{ totalPlays: number }>(window, "genius:getListeningStats", "month"))
      .totalPlays;

  // The first import establishes the baseline. It must not claim the play
  // already on the device happened just now — Rockbox never said when it did.
  const first = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(first.newPlays).toBe(0);
  expect(await monthPlays()).toBe(0);

  // The device records two more plays of the first track.
  fixture([{ playCount: 3, playTimeMs: 600_000, lengthMs: 200_000 }, {}, {}]);
  const second = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(second.newPlays).toBe(1);
  // Those two carry a real host-clock date, so they land in this month.
  expect(await monthPlays()).toBe(2);

  // Importing the unchanged device again must add nothing at all.
  const third = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(third.newPlays).toBe(0);
  expect(await monthPlays()).toBe(2);
  expect(
    (await call<{ totalPlays: number }>(window, "genius:getListeningStats", "all"))
      .totalPlays
  ).toBe(3);
});

test("a rebuilt database that renumbers its entries still matches by path", async () => {
  fixture([{ playCount: 5, playTimeMs: 1_000_000, lengthMs: 200_000 }, {}, {}]);

  const window = await readyWindow();
  const deviceId = await setUp(window);
  await call(window, "device:readRuntimeData", deviceId);

  // Rockbox's "Database → Initialize Now" reorders every entry. Nothing may
  // have cached an index position across the two reads.
  writeTcdFixture(deviceDir, [
    { path: rockboxPath(FILES[2]) },
    { path: rockboxPath(FILES[1]) },
    {
      path: rockboxPath(FILES[0]),
      playCount: 5,
      playTimeMs: 1_000_000,
      lengthMs: 200_000,
    },
  ]);

  const res = await call<ImportResult>(window, "device:readRuntimeData", deviceId);
  expect(res.imported).toBe(3);
  expect(res.unmatched).toBe(0);
  // The same counters seen at new positions are not new plays.
  expect(res.newPlays).toBe(0);
  expect(
    (await call<{ totalPlays: number }>(window, "genius:getListeningStats", "all"))
      .totalPlays
  ).toBe(5);
});
