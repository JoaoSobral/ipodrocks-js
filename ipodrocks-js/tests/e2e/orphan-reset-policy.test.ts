/**
 * E2E — the Sync tab's "Orphan & Reset Policy" and its confirmation gate.
 *
 * The section used to be called "Orphan Policy" and its most destructive option
 * "Remove all", which only swept orphans and unlinked the auto-podcast and
 * extra-audiobook files iPodRocks had recorded. "Delete all" replaces it and is
 * genuinely destructive — it erases the device's Music, Podcasts and Audiobooks
 * folders and rebuilds them — so nothing may reach a sync without the user
 * confirming it first. That gate is what this test exists to prove.
 *
 * The sweeping and erasing behaviour itself runs against a real tmp device in
 * src/__tests__/behaviors/orphan-reset-policy.test.ts, and the folder guard in
 * src/__tests__/regressions/delete-all-path-guard.test.ts. Only the affordance
 * lives here.
 *
 * Run: npm run build && npx playwright test tests/e2e/orphan-reset-policy.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let mountPath: string;
let libraryDir: string;

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  };
}

/** A real 1-second FLAC, so the library scan has something to index. */
function seedTrack(fileName: string): boolean {
  const out = path.join(libraryDir, fileName);
  const res = spawnSync(
    "ffmpeg",
    [
      "-y", "-v", "quiet", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1",
      "-metadata", "title=E2E Orphan Policy Track",
      "-metadata", "artist=E2E Orphan Artist",
      "-metadata", "album=E2E Orphan Album",
      out,
    ],
    { encoding: "utf8" }
  );
  return res.status === 0 && fs.existsSync(out);
}

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-orphan-"));
  mountPath = path.join(rootDir, "device");
  libraryDir = path.join(rootDir, "library");
  fs.mkdirSync(libraryDir, { recursive: true });
  for (const dir of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(mountPath, dir), { recursive: true });
  }
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

/** Add a library folder and scan it, so the pre-sync "empty library" check passes. */
async function scanLibrary(window: Page): Promise<void> {
  await window.evaluate(async (folder) => {
    const api = (window as unknown as ApiWindow).api;
    await api.invoke("library:addFolder", {
      name: "E2E Orphan Seed",
      path: folder,
      contentType: "music",
    });
    await api.invoke("library:scan", {
      folders: [{ name: "E2E Orphan Seed", path: folder, contentType: "music" }],
    });
  }, libraryDir);
}

async function addDevice(window: Page, mount: string): Promise<number> {
  return window.evaluate(async (m) => {
    const created = (await (window as unknown as ApiWindow).api.invoke("device:add", {
      name: "GateDevice",
      mountPath: m,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`device:add failed: ${created.error}`);
    return created.id as number;
  }, mount);
}

/**
 * The policy dropdown's trigger. Matched as a direct child of the Select
 * container: the label's InfoTooltip is also a button, but it sits nested
 * inside the <Label>, so `> button` picks out the trigger unambiguously.
 */
function policySelect(window: Page) {
  return window.getByTestId("orphan-reset-policy").locator("> button");
}

test("the section is named Orphan & Reset Policy and offers Delete all", async () => {
  const window = await readyWindow();
  await addDevice(window, mountPath);

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });

  await policySelect(window).click();
  const options = window.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options).toHaveText([
    "Keep",
    "Remove orphans",
    "Delete all",
    "Prompt",
  ]);
});

test("choosing Delete all confirms before anything is erased", async () => {
  // The Start Sync pre-check refuses an empty library before any policy runs,
  // so the gate can only be reached with something actually in the library.
  test.skip(!seedTrack("track.flac"), "ffmpeg unavailable — cannot seed a library");

  const window = await readyWindow();
  await scanLibrary(window);
  await addDevice(window, mountPath);

  // Plant a file that a wipe would take with it, so "nothing was deleted" is a
  // claim about the disk and not just about which modal appeared.
  const planted = path.join(mountPath, "Podcasts", "Show", "episode.mp3");
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, "keep me until confirmed");

  await window.getByRole("button", { name: "Sync", exact: true }).click();
  await expect(
    window.getByText("Orphan & Reset Policy", { exact: true })
  ).toBeVisible({ timeout: 10_000 });

  await policySelect(window).click();
  await window.getByRole("option", { name: "Delete all" }).click();

  await window.getByRole("button", { name: "Start Sync" }).click();

  // The gate, not the sync.
  await expect(
    window.getByText("Erase and rebuild this device?")
  ).toBeVisible({ timeout: 10_000 });
  expect(fs.existsSync(planted)).toBe(true);

  // Backing out leaves the device exactly as it was.
  await window.getByRole("button", { name: "Cancel" }).click();
  await expect(window.getByText("Erase and rebuild this device?")).toBeHidden();
  expect(fs.readFileSync(planted, "utf8")).toBe("keep me until confirmed");
});
