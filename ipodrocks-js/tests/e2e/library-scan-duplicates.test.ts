/**
 * Playwright E2E — Library scan keeps distinct tracks (dedup-bug regression)
 *
 * Reproduces the reported bug in the real built app: the scanner used to treat
 * two files sharing artist/album/title as duplicates and drop one, losing
 * genuinely distinct tracks (e.g. a same-titled "Intro" on each disc of a
 * multi-disc album). Unparseable placeholder files fall back to their filename
 * stem as the title with "Unknown Artist"/"Unknown Album", so two files both
 * named "Intro.mp3" collide on exactly that key — the bug's trigger.
 *
 * Verifies:
 *  1. Two distinct same-title files both get added and both survive a re-scan.
 *  2. A deleted copy inside a ".Trash-1000" folder is excluded from scanning.
 *  3. Byte-identical copies are kept and reported as a duplicate warning.
 *
 * Seed folders must live under the user's home dir (path allowlist).
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

type ScanResult = {
  filesAdded: number;
  filesProcessed: number;
  filesRemoved?: number;
  warnings?: string[];
  duplicateFilesDetected?: number;
};

let launched: LaunchedApp;
let seedDir: string;

async function scan(window: import("@playwright/test").Page): Promise<ScanResult> {
  return (await window.evaluate(
    (folderPath) =>
      (window as unknown as ApiWindow).api.invoke("library:scan", {
        folders: [{ name: "E2E Dup Seed", path: folderPath, contentType: "music" }],
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
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-dup-"));
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

test("scan keeps distinct same-title tracks and excludes trash copies", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Two distinct files that collapse to the same (Unknown Artist, Unknown
  // Album, "Intro") key — the exact collision the old dedup dropped.
  fs.mkdirSync(path.join(seedDir, "Disc 1"), { recursive: true });
  fs.mkdirSync(path.join(seedDir, "Disc 2"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "Disc 1/Intro.mp3"), Buffer.from("disc-one-distinct-bytes"));
  fs.writeFileSync(path.join(seedDir, "Disc 2/Intro.mp3"), Buffer.from("disc-two-distinct-bytes"));

  const first = await scan(window);
  expect(first.filesAdded).toBe(2);

  let paths = await trackPaths(window);
  expect(paths).toHaveLength(2);
  expect(paths.some((p) => p.includes(path.join("Disc 1", "Intro.mp3")))).toBe(true);
  expect(paths.some((p) => p.includes(path.join("Disc 2", "Intro.mp3")))).toBe(true);

  // Re-scan must not drop either track.
  const second = await scan(window);
  expect(second.filesRemoved ?? 0).toBe(0);
  paths = await trackPaths(window);
  expect(paths).toHaveLength(2);

  // A deleted copy inside a trash folder must be excluded from scanning.
  fs.mkdirSync(path.join(seedDir, ".Trash-1000/files"), { recursive: true });
  fs.writeFileSync(
    path.join(seedDir, ".Trash-1000/files/Intro.mp3"),
    Buffer.from("trashed-copy-bytes")
  );
  await scan(window);
  paths = await trackPaths(window);
  expect(paths).toHaveLength(2);
  expect(paths.some((p) => p.includes("Trash"))).toBe(false);
});

test("scan keeps byte-identical duplicates and reports a duplicate warning", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const bytes = Buffer.from("identical-content-bytes");
  fs.writeFileSync(path.join(seedDir, "original.mp3"), bytes);
  fs.writeFileSync(path.join(seedDir, "copy.mp3"), bytes);

  const result = await scan(window);
  expect(result.filesAdded).toBe(2);
  expect((await trackPaths(window)).length).toBe(2);
  expect(result.duplicateFilesDetected).toBe(1);
  expect(result.warnings?.length).toBe(1);
});
