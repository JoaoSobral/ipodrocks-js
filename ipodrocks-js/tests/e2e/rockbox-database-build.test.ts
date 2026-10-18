/**
 * E2E — the Sync tab's "Build Rockbox database" option.
 *
 * Opt-in per device: off until the user ticks it, then remembered for that
 * device. With it on, the sync writes `.rockbox/database_*.tcd` itself, so the
 * player needs no Database → Update now, and the play statistics and ratings
 * already in the device's database come across into the new one.
 *
 * The byte layout is pinned in src/__tests__/regressions/tagcache-encoder.test.ts
 * and the carry-over rules in tagcache-sync-build.test.ts. Here: the checkbox,
 * its persistence, and a real sync producing a database Rockbox can read.
 *
 * Run: npm run build && npx playwright test tests/e2e/rockbox-database-build.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import { writeTcdFixture } from "../../src/__tests__/harness/tcd-fixture";
import {
  INDEX_FILE_NAME,
  STRING_TAGS,
  decodeTagcache,
  tagFileName,
} from "../../src/main/rockbox/tagcache-build";
import { detectFatClock, rockboxMtime } from "../../src/main/rockbox/tagcache-sync";

let launched: LaunchedApp;
let rootDir: string;
let mountPath: string;
let libraryDir: string;

/**
 * Where the sync puts the seeded track: "Mirror library folder structure" is
 * on by default, and it keeps the library folder's own name.
 */
const SYNCED_REL = "Music/library/track.flac";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

/** A real 1-second FLAC carrying the tags the database should end up with. */
function seedTrack(fileName: string): boolean {
  const out = path.join(libraryDir, fileName);
  const res = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1",
      "-metadata", "title=E2E Rockbox DB Track",
      "-metadata", "artist=E2E DB Artist",
      "-metadata", "album=E2E DB Album",
      "-metadata", "date=1987",
      "-metadata", "composer=E2E Composer",
      "-metadata", "track=4",
      out,
    ],
    { encoding: "utf8" }
  );
  return res.status === 0 && fs.existsSync(out);
}

function readDeviceDatabase() {
  const rb = path.join(mountPath, ".rockbox");
  const tagFiles = new Map<number, Buffer>();
  for (const tag of STRING_TAGS) {
    const p = path.join(rb, tagFileName(tag));
    if (fs.existsSync(p)) tagFiles.set(tag, fs.readFileSync(p));
  }
  return decodeTagcache(fs.readFileSync(path.join(rb, INDEX_FILE_NAME)), tagFiles);
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-rbdb-"));
  mountPath = path.join(rootDir, "device");
  libraryDir = path.join(rootDir, "library");
  fs.mkdirSync(libraryDir, { recursive: true });
  for (const dir of ["Music", "Podcasts", "Audiobooks", "Playlists", ".rockbox"]) {
    fs.mkdirSync(path.join(mountPath, dir), { recursive: true });
  }
  fs.writeFileSync(
    path.join(mountPath, ".rockbox", "rockbox-info.txt"),
    "Target: ipodvideo\nVersion: 4.0\n"
  );
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

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () =>
      typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke ===
      "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

async function scanLibrary(window: Page): Promise<void> {
  await window.evaluate(async (folder) => {
    const api = (window as unknown as ApiWindow).api;
    await api.invoke("library:addFolder", {
      name: "E2E Rockbox DB Seed",
      path: folder,
      contentType: "music",
    });
    await api.invoke("library:scan", {
      folders: [{ name: "E2E Rockbox DB Seed", path: folder, contentType: "music" }],
    });
  }, libraryDir);
}

async function addDevice(window: Page): Promise<number> {
  return window.evaluate(async (m) => {
    const created = (await (window as unknown as ApiWindow).api.invoke("device:add", {
      name: "RockboxDbDevice",
      mountPath: m,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`device:add failed: ${created.error}`);
    return created.id as number;
  }, mountPath);
}

async function openSyncTab(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(window.getByTestId("build-rockbox-db")).toBeVisible({ timeout: 10_000 });
}

async function runSyncFromUi(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Start Sync" }).click();
  const dialog = window.getByRole("dialog").filter({ hasText: "Syncing to Device" });
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Close" }).click();
}

test("off by default: a sync leaves the device's database alone", async () => {
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");
  const window = await readyWindow();
  await scanLibrary(window);
  await addDevice(window);

  await openSyncTab(window);
  await expect(window.getByTestId("build-rockbox-db")).not.toBeChecked();
  await runSyncFromUi(window);

  expect(fs.existsSync(path.join(mountPath, SYNCED_REL))).toBe(true);
  expect(fs.existsSync(path.join(mountPath, ".rockbox", INDEX_FILE_NAME))).toBe(false);
});

test("ticked: the sync builds the database, keeps device statistics, and remembers the choice", async () => {
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  // A database the player built earlier, which already holds statistics for
  // the track this sync is about to (re)write. They must survive the rebuild.
  writeTcdFixture(mountPath, [
    { path: `/${SYNCED_REL}`, playCount: 5, rating: 4, lastPlayedSerial: 12, lengthMs: 1000 },
  ]);
  fs.mkdirSync(path.dirname(path.join(mountPath, SYNCED_REL)), { recursive: true });
  fs.writeFileSync(path.join(mountPath, SYNCED_REL), "placeholder");
  // A file the library does not know about, put on the player by hand.
  fs.mkdirSync(path.join(mountPath, "Manual"), { recursive: true });
  fs.copyFileSync(path.join(libraryDir, "track.flac"), path.join(mountPath, "Manual", "hand.flac"));

  const window = await readyWindow();
  await scanLibrary(window);
  const deviceId = await addDevice(window);

  await openSyncTab(window);
  await window.getByTestId("build-rockbox-db").check();
  await runSyncFromUi(window);

  const db = readDeviceDatabase();
  const byName = new Map(db.entries.map((e) => [e.filename, e]));
  expect([...byName.keys()].sort()).toEqual(["/Manual/hand.flac", `/${SYNCED_REL}`]);

  const synced = byName.get(`/${SYNCED_REL}`)!;
  expect(synced).toMatchObject({
    title: "E2E Rockbox DB Track",
    artist: "E2E DB Artist",
    album: "E2E DB Album",
    composer: "E2E Composer",
    year: 1987,
    tracknumber: 4,
  });
  expect(synced.runtime).toMatchObject({ playcount: 5, rating: 4, lastplayed: 12 });
  // The mtime Rockbox's auto-update will compare against. A mismatch makes the
  // player re-index every file on its next boot.
  expect(synced.mtime).toBe(
    rockboxMtime(fs.statSync(path.join(mountPath, SYNCED_REL)).mtimeMs, detectFatClock(mountPath))
  );
  expect(synced.mtime).toBeGreaterThan(0);
  expect(db.header.serial).toBeGreaterThan(12);
  expect(db.header.dirty).toBe(0);
  // Read off the device itself, the way Rockbox's own scan would have.
  expect(byName.get("/Manual/hand.flac")!.title).toBe("E2E Rockbox DB Track");

  // Remembered for this device: stored, and ticked when the tab comes back.
  const prefs = (await window.evaluate(
    (id) => (window as unknown as ApiWindow).api.invoke("sync:getDevicePreferences", id),
    deviceId
  )) as { buildRockboxDatabase: boolean };
  expect(prefs.buildRockboxDatabase).toBe(true);

  await window.getByRole("button", { name: "Library", exact: true }).click();
  await openSyncTab(window);
  await expect(window.getByTestId("build-rockbox-db")).toBeChecked();
});
