/**
 * Playwright E2E — Unicode (NFC/NFD) filenames are scanned stably
 *
 * Reproduces the SMB/SAMBA symptom in the real built app: files whose names
 * contain Unicode characters were re-added/re-removed on every scan because the
 * scanner compared raw `readdir` paths against DB-stored paths byte-for-byte
 * without normalizing NFC vs NFD. The fix stores every path NFC-normalized.
 *
 * We create files with explicitly NFD (decomposed) names. APFS preserves the
 * created form, so `readdir` returns NFD; the app must store NFC and a second
 * scan must be a no-op (add 0 / remove 0) — the perpetual-rescan symptom gone.
 *
 * NOT reproducible in CI: a real SMB mount, and the legacy-DB precondition
 * (rows stored in the opposite form before the fix). Those are covered by the
 * behavior + migration unit tests. Seed folders live under the home dir for
 * the path allowlist.
 *
 * Run with: `npm run build && npx playwright test`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}
type ScanResult = { filesAdded: number; filesRemoved?: number };

// "Sinéad/Café.mp3" with decomposed accents (e + U+0301 combining acute).
const NFD_REL = "Sine\u0301ad/Cafe\u0301.mp3";

let launched: LaunchedApp;
let seedDir: string;

async function scan(window: import("@playwright/test").Page): Promise<ScanResult> {
  return (await window.evaluate(
    (folderPath) =>
      (window as unknown as ApiWindow).api.invoke("library:scan", {
        folders: [{ name: "E2E Unicode", path: folderPath, contentType: "music" }],
      }),
    seedDir
  )) as ScanResult;
}

async function trackPaths(window: import("@playwright/test").Page): Promise<string[]> {
  const tracks = (await window.evaluate(() =>
    (window as unknown as ApiWindow).api.invoke("library:getTracks", { contentType: "music" })
  )) as Array<{ path: string }>;
  return tracks.map((t) => t.path);
}

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-uni-"));
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

test("Unicode-named files scan once and stay stable on re-scan", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const full = path.join(seedDir, NFD_REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from("unicode-audio-bytes"));

  const first = await scan(window);
  expect(first.filesAdded).toBe(1);

  let paths = await trackPaths(window);
  expect(paths).toHaveLength(1);
  // Stored path must be NFC-normalized.
  expect(paths[0]).toBe(paths[0].normalize("NFC"));

  // Second scan must not churn: the reported symptom was the same file being
  // re-added/re-removed every scan.
  const second = await scan(window);
  expect(second.filesAdded).toBe(0);
  expect(second.filesRemoved ?? 0).toBe(0);
  paths = await trackPaths(window);
  expect(paths).toHaveLength(1);
});
