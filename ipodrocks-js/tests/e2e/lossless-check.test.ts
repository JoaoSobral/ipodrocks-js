/**
 * E2E — the Library's "Check lossless…": find FLACs that are really MP3s.
 *
 * Drives the rendered UI over a real library made by ffmpeg: genuine pink-noise
 * FLACs (each a different seed, so the scan does not fold them as duplicates),
 * one FLAC decoded from a 128 kbps MP3, and a plain MP3 that is not a candidate
 * at all. Then, in order:
 *
 * 1. The check runs **in the background**: "Run in background" hides the
 *    window and the toolbar chip brings it back while the run continues —
 *    the user's own request, and why the run's state lives in a store rather
 *    than the modal.
 * 2. The verdicts: the transcode is "Lossy-sourced (strong)", the genuine files
 *    are not flagged, the MP3 is never checked.
 * 3. **Both exports** carry title, album and path. A Blob download is captured
 *    at `URL.createObjectURL`, which works identically in Electron and Chrome.
 * 4. The Library's **Lossless column and filter** show the same verdicts.
 * 5. **Mark as OK** takes a file out of the flagged list.
 * 6. **Delete** removes the file and its library row; the desktop sends it to
 *    the OS trash (cleaned up afterwards — see `cleanTrash`).
 *
 * The verdict logic is pinned in src/__tests__/lossless-verdict.test.ts, the
 * pipeline in regressions/lossless-check-pipeline.test.ts, the guards in
 * regressions/lossless-ipc-guards.test.ts.
 *
 * Run: npm run build && npx playwright test tests/e2e/lossless-check.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let libraryDir: string;

const FAKE = "ipr-e2e-lossless-fake.flac";
/** Enough files that the run reliably outlasts the click that minimises it. */
const GENUINE_COUNT = 30;

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

function ffmpeg(args: string[]): boolean {
  return spawnSync("ffmpeg", ["-y", "-v", "error", ...args], { encoding: "utf8" }).status === 0;
}

function noise(seed: number): string {
  return `anoisesrc=color=pink:r=44100:a=0.3:d=22:seed=${seed},volume='0.6+0.4*sin(2*PI*t*0.5)':eval=frame`;
}

/** Real audio: genuine FLACs, one MP3-128 → FLAC transcode, one plain MP3. */
function seedLibrary(): boolean {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-lossless-src-"));
  try {
    for (let i = 0; i < GENUINE_COUNT; i++) {
      const ok = ffmpeg([
        "-f", "lavfi", "-i", noise(i + 1), "-ac", "2",
        "-metadata", `title=Genuine ${i + 1}`, "-metadata", "artist=E2E Real", "-metadata", "album=E2E Real Album",
        path.join(libraryDir, `genuine-${i + 1}.flac`),
      ]);
      if (!ok) return false;
    }
    const mp3 = path.join(scratch, "t.mp3");
    return (
      ffmpeg(["-f", "lavfi", "-i", noise(99), "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", mp3]) &&
      ffmpeg([
        "-i", mp3, "-metadata", "title=Fake 128", "-metadata", "artist=E2E Fake", "-metadata", "album=E2E Fake Album",
        path.join(libraryDir, FAKE),
      ]) &&
      ffmpeg([
        "-f", "lavfi", "-i", noise(7), "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k",
        "-metadata", "title=Plain MP3", path.join(libraryDir, "plain.mp3"),
      ])
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The desktop trashes rather than unlinks; do not leave fixtures in the developer's Trash. */
function cleanTrash(): void {
  const dirs = [
    path.join(os.homedir(), ".local/share/Trash/files"),
    path.join(os.homedir(), ".local/share/Trash/info"),
    path.join(os.homedir(), ".Trash"),
  ];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.startsWith("ipr-e2e-lossless-fake")) fs.rmSync(path.join(d, f), { recursive: true, force: true });
      }
    } catch {
      /* no such trash on this platform */
    }
  }
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-lossless-"));
  libraryDir = path.join(rootDir, "library");
  fs.mkdirSync(libraryDir, { recursive: true });
  launched = await launchApp();
});

test.afterEach(async () => {
  try {
    await launched?.cleanup();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    cleanTrash();
  }
});

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
    await api.invoke("library:addFolder", { name: "E2E Lossless", path: folder, contentType: "music" });
    await api.invoke("library:scan", { folders: [{ name: "E2E Lossless", path: folder, contentType: "music" }] });
  }, libraryDir);
}

/** Capture the next Blob download's name and text instead of saving it. */
async function captureDownload(window: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  await window.evaluate(() => {
    const w = window as unknown as { __dl?: { blob?: Blob; name?: string } };
    w.__dl = {};
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__dl!.blob = b as Blob;
      return "blob:captured";
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      w.__dl!.name = this.download;
    };
  });
  await click();
  return window.evaluate(async () => {
    const w = window as unknown as { __dl: { blob: Blob; name: string } };
    return { name: w.__dl.name, text: await w.__dl.blob.text() };
  });
}

test("finds the MP3 posing as a FLAC, in the background, and exports, marks and deletes it", async () => {
  test.setTimeout(180_000);
  test.skip(!seedLibrary(), "ffmpeg with libmp3lame unavailable — cannot make the fixtures");
  const window = await readyWindow();
  await scanLibrary(window);

  await window.getByRole("button", { name: "Library" }).first().click();
  await window.getByTestId("lossless-open").click();
  const modal = window.getByTestId("lossless-check-modal");
  await expect(modal).toBeVisible();
  await window.getByTestId("lossless-start").click();

  // 1. Background: hide it straight away; the chip shows the run continuing.
  await window.getByTestId("lossless-background").click();
  await expect(modal).toBeHidden();
  const chip = window.getByTestId("lossless-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("Lossless check");
  // The rest of the app is usable meanwhile.
  await expect(window.getByTestId("lossless-filter")).toBeVisible();
  // Dispatched rather than clicked: the chip's text changes with every
  // progress frame, and in the hidden e2e window Playwright's "stable for two
  // animation frames" check can outlast the run (its box does not move —
  // that was measured). The handler under test is the same.
  await chip.dispatchEvent("click");
  await expect(modal).toBeVisible();

  // 2. Verdicts.
  const results = window.getByTestId("lossless-results");
  await expect(results).toBeVisible({ timeout: 120_000 });
  await expect(window.getByTestId("lossless-summary")).toContainText(`${GENUINE_COUNT + 1} file(s) checked`);
  const fakeRow = results.locator(`[data-testid="lossless-row"][data-path$="${FAKE}"]`);
  await expect(fakeRow).toHaveAttribute("data-verdict", "lossy_strong");
  await expect(fakeRow).toContainText("Lossy-sourced (strong)");
  await expect(fakeRow).toContainText(/MP3/);
  // "Flagged" is the default filter: no genuine file, and never the MP3.
  await expect(results.locator('[data-testid="lossless-row"]')).toHaveCount(1);
  await window.getByRole("button", { name: /^All checked/ }).click();
  await expect(results.locator('[data-testid="lossless-row"]')).toHaveCount(GENUINE_COUNT + 1);
  await expect(results.locator('[data-testid="lossless-row"][data-verdict="genuine"]')).toHaveCount(GENUINE_COUNT);
  await expect(results.locator('[data-path$="plain.mp3"]')).toHaveCount(0);
  await window.getByRole("button", { name: /^Flagged/ }).click();

  // 3. Exports.
  const csv = await captureDownload(window, () => window.getByRole("button", { name: "Export CSV" }).click());
  expect(csv.name).toMatch(/^lossless-check-.*\.csv$/);
  expect(csv.text).toContain('"Fake 128"');
  expect(csv.text).toContain('"E2E Fake Album"');
  expect(csv.text).toContain(path.join(libraryDir, FAKE));
  const md = await captureDownload(window, () => window.getByRole("button", { name: "Export Markdown" }).click());
  expect(md.name).toMatch(/^lossless-check-.*\.md$/);
  expect(md.text).toContain("| Fake 128 | E2E Fake | E2E Fake Album | Lossy-sourced (strong)");
  expect(md.text).toContain(path.join(libraryDir, FAKE));

  // 4. The Library column and filter.
  await window.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(window.locator('[data-testid="lossless-cell"] [data-verdict="lossy_strong"]')).toHaveCount(1);
  // The track list is virtualised: only the rows on screen exist, so this is
  // "genuine files show as genuine", not a count.
  await expect(window.locator('[data-testid="lossless-cell"] [data-verdict="genuine"]').first()).toBeVisible();
  await window.getByTestId("lossless-filter").locator("> button").click();
  await window.getByRole("option", { name: "Lossy-sourced (strong)" }).click();
  await expect(window.locator('[data-testid="lossless-cell"]')).toHaveCount(1);
  await expect(window.getByText("Fake 128").first()).toBeVisible();

  // 5. Mark as OK takes it out of the flagged list; unmark puts it back.
  await window.getByTestId("lossless-open").click();
  await expect(results).toBeVisible();
  await window.getByRole("checkbox", { name: "Select Fake 128" }).check();
  await window.getByRole("button", { name: "Mark as OK" }).click();
  await expect(results.locator('[data-testid="lossless-row"]')).toHaveCount(0);
  await window.getByRole("button", { name: /^All checked/ }).click();
  await window.getByRole("checkbox", { name: "Select Fake 128" }).check();
  await window.getByRole("button", { name: "Unmark" }).click();
  await window.getByRole("button", { name: /^Flagged/ }).click();
  await expect(results.locator('[data-testid="lossless-row"]')).toHaveCount(1);

  // 6. Delete: confirm says Trash on the desktop; file and row are gone.
  await window.getByRole("checkbox", { name: "Select Fake 128" }).check();
  await window.getByTestId("lossless-delete").click();
  await expect(modal).toContainText("They will be moved to the Trash.");
  await window.getByTestId("lossless-confirm-delete").click();
  await expect(window.getByTestId("lossless-delete-result")).toContainText("Deleted 1 file(s)");
  await expect(window.getByTestId("lossless-delete-result")).toContainText("moved to the Trash");
  expect(fs.existsSync(path.join(libraryDir, FAKE))).toBe(false);
  expect(fs.existsSync(path.join(libraryDir, "genuine-1.flac"))).toBe(true);
  const remaining = await window.evaluate(async () => {
    const tracks = (await (window as unknown as ApiWindow).api.invoke("library:getTracks")) as { title: string }[];
    return tracks.map((t) => t.title);
  });
  expect(remaining).not.toContain("Fake 128");
  expect(remaining).toContain("Genuine 1");
});
