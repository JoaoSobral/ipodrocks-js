/**
 * E2E — the Sync panel's "Device Status" card.
 *
 * The panel used to end with a "Sync Results" card that only appeared after a
 * run. It is replaced by a Device Status card answering the question you
 * actually have while configuring a sync: what is on the device right now.
 *
 * Drives the real built app (renderer → preload → main → SQLite → filesystem):
 * two dev-mode devices are pointed at real folders, one holding music and
 * playlist files and one empty, and the card is checked against what is
 * genuinely on disk.
 *
 * `device:check` is expensive, so the card caches per device. Selecting a
 * device runs one check; switching back reuses it. That is asserted here by
 * switching devices and back, and by the Refresh button re-running it.
 *
 * Seed folders live under the user's home dir (main-process path allowlist).
 *
 * Run: npm run build && npx playwright test tests/e2e/sync-device-status.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

let launched: LaunchedApp;
let fullDeviceDir: string;
let emptyDeviceDir: string;

const FULL_DEVICE = "E2E Status Full";
const EMPTY_DEVICE = "E2E Status Empty";
const MUSIC_FILES = 3;
const PLAYLIST_FILES = 2;

/** Plant real files in the device's default folder layout. */
function seedDevice(root: string): void {
  for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  }
  const album = path.join(root, "Music", "E2E Artist", "E2E Album");
  fs.mkdirSync(album, { recursive: true });
  for (let i = 1; i <= MUSIC_FILES; i++) {
    fs.writeFileSync(path.join(album, `0${i} - Song.mp3`), "x".repeat(2048));
  }
  for (let i = 1; i <= PLAYLIST_FILES; i++) {
    fs.writeFileSync(
      path.join(root, "Playlists", `E2E List ${i}.m3u`),
      "#EXTM3U\n/Music/E2E Artist/E2E Album/01 - Song.mp3\n"
    );
  }
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

/**
 * `devMode` bypasses the mount-point check, so a plain folder under $HOME is
 * treated as a connected device — otherwise every check would return offline.
 */
async function addDevices(window: Page): Promise<void> {
  await window.evaluate(
    async ([full, empty, fullName, emptyName]) => {
      const api = (window as unknown as ApiWindow).api;
      await api.invoke("device:add", { name: fullName, mountPath: full, devMode: true });
      await api.invoke("device:add", { name: emptyName, mountPath: empty, devMode: true });
    },
    [fullDeviceDir, emptyDeviceDir, FULL_DEVICE, EMPTY_DEVICE]
  );
}

/** The Device Status card, once it has finished its automatic first check. */
function statusCard(window: Page) {
  return window.locator('[data-testid="device-status-card"]');
}

/** The number on one of the four stat tiles, e.g. "playlists". */
async function tileValue(window: Page, tile: string): Promise<string> {
  const value = window.locator(`[data-testid="device-status-${tile}-value"]`);
  await value.waitFor({ timeout: 15_000 });
  return (await value.innerText()).trim();
}

/** Whole text of the orphans banner or the device-space box. */
async function boxText(window: Page, box: "orphans" | "space"): Promise<string> {
  const el = window.locator(`[data-testid="device-status-${box}"]`);
  await el.waitFor({ timeout: 15_000 });
  return (await el.innerText()).replace(/\s+/g, " ").trim();
}

/** Pick a device in the Target Device dropdown (a custom, button-driven Select). */
async function selectDevice(window: Page, name: string): Promise<void> {
  await window.locator('button:has-text("E2E Status")').first().click();
  await window.locator(`[role="option"]:has-text("${name}")`).first().click();
}

test.beforeEach(async () => {
  fullDeviceDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-statusfull-"));
  emptyDeviceDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-statusempty-"));
  seedDevice(fullDeviceDir);
  fs.mkdirSync(path.join(emptyDeviceDir, "Music"), { recursive: true });
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  for (const dir of [fullDeviceDir, emptyDeviceDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test("Device Status replaces Sync Results and reports what is on the device", async () => {
  const window = await readyWindow();
  await addDevices(window);

  await window.click('button:has-text("Sync")');

  // The panel pre-selects the first device, so the card checks it on its own.
  await expect(statusCard(window)).toBeVisible({ timeout: 15_000 });
  await expect(statusCard(window).locator('h3:text-is("Device Status")')).toBeVisible();

  // The card it replaced is gone for good — not merely hidden until a sync.
  await expect(window.locator("text=Sync Results")).toHaveCount(0);

  await selectDevice(window, FULL_DEVICE);

  // Every tile the card promises is present.
  for (const tile of ["songs", "podcasts", "audiobooks", "playlists"]) {
    await expect(
      window.locator(`[data-testid="device-status-${tile}"]`)
    ).toBeVisible({ timeout: 15_000 });
  }

  // Playlists and orphans are counted off the real filesystem: the library is
  // empty, so every file planted on the device is an orphan.
  await expect.poll(() => tileValue(window, "playlists"), { timeout: 15_000 }).toBe(
    String(PLAYLIST_FILES)
  );
  const orphans = await boxText(window, "orphans");
  expect(orphans).toContain(`${MUSIC_FILES + PLAYLIST_FILES} orphans`);
  expect(orphans).toContain(`${MUSIC_FILES} music`);
  expect(orphans).toContain(`${PLAYLIST_FILES} playlist`);

  // Space reads as "used / total", not as raw bytes.
  expect(await boxText(window, "space")).toMatch(/\d+\.\d GB \/ \d+\.\d GB/);
});

test("switching devices re-checks, and switching back reuses the cached result", async () => {
  const window = await readyWindow();
  await addDevices(window);

  await window.click('button:has-text("Sync")');
  await expect(statusCard(window)).toBeVisible({ timeout: 15_000 });

  await selectDevice(window, FULL_DEVICE);
  await expect.poll(() => tileValue(window, "playlists"), { timeout: 15_000 }).toBe(
    String(PLAYLIST_FILES)
  );

  // The empty device is a different device, so it gets its own check.
  await selectDevice(window, EMPTY_DEVICE);
  await expect.poll(() => tileValue(window, "playlists"), { timeout: 15_000 }).toBe("0");
  expect(await boxText(window, "orphans")).toContain("No orphans");

  // Back to the first: served from the cache, so the numbers return without
  // the card ever dropping into its "Checking…" state.
  await selectDevice(window, FULL_DEVICE);
  await expect(statusCard(window).locator('button:has-text("Checking…")')).toHaveCount(0);
  expect(await tileValue(window, "playlists")).toBe(String(PLAYLIST_FILES));
});

test("Refresh re-runs the check and picks up files added since", async () => {
  const window = await readyWindow();
  await addDevices(window);

  await window.click('button:has-text("Sync")');
  await expect(statusCard(window)).toBeVisible({ timeout: 15_000 });
  await selectDevice(window, FULL_DEVICE);
  await expect.poll(() => tileValue(window, "playlists"), { timeout: 15_000 }).toBe(
    String(PLAYLIST_FILES)
  );

  fs.writeFileSync(
    path.join(fullDeviceDir, "Playlists", "E2E Added Later.m3u"),
    "#EXTM3U\n"
  );

  await statusCard(window).locator('button:has-text("Refresh")').click();
  await expect.poll(() => tileValue(window, "playlists"), { timeout: 15_000 }).toBe(
    String(PLAYLIST_FILES + 1)
  );
});
