/**
 * E2E — key/BPM analysis belongs to the library scan, not to Savant.
 *
 * A file with no key tag used to be analysed only by a Backfill button on the
 * Savant tab, while the Settings tooltip said scans did it and the Library
 * banner said "re-scan" — which never helped (a reporter's 99 tagless .m4a
 * files sat at 97% through every rescan). Now:
 *
 *  - the Savant tab has no Backfill; it says key data is missing and points to
 *    Settings, and Savant still works without it;
 *  - with "Analyze with Essentia.js" on, Scan Library analyses the tracks still
 *    missing key data as its last step — a rescan of unchanged files included —
 *    and the scan summary says how many.
 *
 * Real ffmpeg for the tagless file, real Essentia in the built app.
 *
 * Run: npm run build && npx playwright test tests/e2e/harmonic-scan.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let libDir: string;

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

test.beforeEach(async () => {
  libDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-harmonic-"));
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  fs.rmSync(libDir, { recursive: true, force: true });
});

function invoke<T = unknown>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([c, a]) => (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

test("Savant points to Settings instead of a Backfill, and the scan fills in the keys", async () => {
  test.setTimeout(120_000);
  const made = spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=554.37:duration=12",
    "-filter_complex", "amix=inputs=2", "-map_metadata", "-1",
    "-metadata", "title=No Key Tag",
    path.join(libDir, "untagged.flac"),
  ]);
  test.skip(made.status !== 0, "ffmpeg unavailable — cannot seed a library");

  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );

  const folder = { name: "Harmonic Lib", path: libDir, contentType: "music" };
  await invoke(window, "settings:setHarmonicPrefs", { scanHarmonicData: true, analyzeWithEssentia: false });
  await invoke(window, "library:addFolder", folder);
  await invoke(window, "library:scan", { folders: [folder] });
  expect((await invoke<{ keyedCount: number }>(window, "savant:checkKeyData")).keyedCount).toBe(0);

  // Savant: a note pointing at Settings, and no Backfill.
  await invoke(window, "settings:setOpenRouterConfig", { apiKey: "sk-or-e2e-not-a-real-key", model: "x/y" });
  await window.getByRole("button", { name: "Playlists", exact: true }).first().click();
  await window.getByRole("button", { name: "savant", exact: true }).click();
  await window.getByRole("button", { name: "+ Create Playlist" }).first().click();
  await window.getByRole("button", { name: /Savant Playlist/ }).click();
  const notice = window.getByTestId("savant-key-notice");
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText("No key/BPM data found");
  await expect(notice).toContainText("Savant still works without it");
  await expect(window.getByRole("button", { name: "Backfill Key Data" })).toHaveCount(0);
  await window.keyboard.press("Escape");

  // Turn Essentia on and rescan the unchanged file from the Library.
  await invoke(window, "settings:setHarmonicPrefs", {
    scanHarmonicData: true,
    analyzeWithEssentia: true,
    analyzePercent: 100,
  });
  await window.getByRole("button", { name: "Library", exact: true }).first().click();
  await window.getByRole("button", { name: /Scan Library/ }).click();
  await expect(window.getByTestId("scan-keys-analyzed")).toContainText("Key/BPM analysed for 1 track", {
    timeout: 90_000,
  });
  expect((await invoke<{ keyedCount: number }>(window, "savant:checkKeyData")).keyedCount).toBe(1);
});
