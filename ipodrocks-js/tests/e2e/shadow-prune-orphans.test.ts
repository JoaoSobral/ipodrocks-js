/**
 * E2E — pruning orphaned files from a shadow library.
 *
 * A shadow library is meant to be a faithful copy of the main library in a
 * different codec. Before the app captured `removedShadowPaths` during a scan,
 * renaming or deleting an album left its transcodes behind with no
 * `shadow_tracks` row pointing at them — so the shadow tree accumulated copies
 * of albums the library no longer had. The cog-wheel **Prune orphan files**
 * action is the one-shot cleanup for that backlog.
 *
 * Drives the real built app: creates a shadow library through IPC, plants
 * unclaimed files in its folder the way an old rename would have, and checks
 * the prune removes exactly those and nothing else.
 *
 * Run: npm run build && npx playwright test tests/e2e/shadow-prune-orphans.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let rootDir: string;
let shadowDir: string;

interface ApiWindow {
  api: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  };
}

type PruneResult = { deleted: number; bytesFreed: number; scanned: number };

test.beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-prune-"));
  shadowDir = path.join(rootDir, "shadow");
  fs.mkdirSync(shadowDir, { recursive: true });
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
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

/** Create a shadow library over an empty library and wait for the build to settle. */
async function createShadowLib(window: Page, shadowPath: string): Promise<number> {
  return window.evaluate(async (p) => {
    const api = (window as unknown as ApiWindow).api;

    let done: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const unsub = api.on("shadow:buildProgress", (...args: unknown[]) => {
      const ev = args[args.length - 1] as { status: string };
      if (ev.status === "complete" || ev.status === "error" || ev.status === "paused") done();
    });

    const configs = (await api.invoke("device:getCodecConfigs")) as Array<{
      id: number;
      codec_name: string;
    }>;
    const mp3 = configs.find((c) => (c.codec_name ?? "").toUpperCase() === "MP3");
    if (!mp3) throw new Error("no MP3 codec configuration");

    const created = (await api.invoke("shadow:create", {
      name: `Prune ${Date.now()}`,
      path: p,
      codecConfigId: mp3.id,
      vbrEnabled: false,
    })) as { id?: number; error?: string };
    if (created.error) throw new Error(`shadow:create failed: ${created.error}`);

    await finished;
    unsub();
    return created.id as number;
  }, shadowPath);
}

function prune(window: Page, id: number): Promise<PruneResult> {
  return window.evaluate(
    async (shadowId) =>
      (await (window as unknown as ApiWindow).api.invoke(
        "shadow:pruneOrphans",
        shadowId
      )) as PruneResult,
    id
  ) as Promise<PruneResult>;
}

test("prunes leftover album files and their artwork, keeping the folder root", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  // The library is empty, so everything planted here is an orphan — exactly the
  // state left behind by albums renamed before the fix.
  const oldAlbum = path.join(shadowDir, "Artist", "Donald");
  fs.mkdirSync(oldAlbum, { recursive: true });
  fs.writeFileSync(path.join(oldAlbum, "01 - Song.mp3"), "x".repeat(1024));
  fs.writeFileSync(path.join(oldAlbum, "cover.jpg"), "art");

  const result = await prune(window, shadowLibId);

  expect(result.deleted).toBe(2);
  expect(result.bytesFreed).toBeGreaterThanOrEqual(1024);
  expect(fs.existsSync(oldAlbum)).toBe(false);
  // The configured shadow folder itself must survive.
  expect(fs.existsSync(shadowDir)).toBe(true);
});

test("is a no-op on a shadow library with nothing stale in it", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  const result = await prune(window, shadowLibId);

  expect(result.deleted).toBe(0);
  expect(result.bytesFreed).toBe(0);
});

test("running the prune twice is safe", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  const stale = path.join(shadowDir, "Artist", "Gone");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "01.mp3"), "stale");

  expect((await prune(window, shadowLibId)).deleted).toBe(1);
  expect((await prune(window, shadowLibId)).deleted).toBe(0);
});

test("never deletes anything outside the shadow library folder", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  const outside = path.join(rootDir, "precious.mp3");
  fs.writeFileSync(outside, "do not touch");

  const stale = path.join(shadowDir, "Stale");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "01.mp3"), "stale");

  await prune(window, shadowLibId);

  expect(fs.existsSync(outside)).toBe(true);
});

test("the prune action is reachable from the shadow library cog menu", async () => {
  const window = await readyWindow();
  await createShadowLib(window, shadowDir);

  await window.click('button:has-text("Library")').catch(() => {});
  // The shadow row reveals its actions on hover.
  const row = window.locator("text=/^Prune \\d+/").first();
  await row.hover({ timeout: 10_000 });

  const cog = window.locator('button[title="More actions"]').first();
  await expect(cog).toBeVisible({ timeout: 10_000 });
  await cog.click();

  const item = window.locator('[role="menuitem"]:has-text("Prune orphan files")');
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  await expect(window.locator('text="Prune orphan files?"')).toBeVisible({
    timeout: 5_000,
  });
});
