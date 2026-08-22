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
 * Only what needs the real app lives here — the cog menu, its confirm gate and
 * the IPC round trip. The classification rules themselves (artwork kept for
 * live albums, AppleDouble sidecars, unreachable roots) are pure and are
 * covered in src/__tests__/shadow-prune-decide.test.ts and
 * src/__tests__/behaviors/shadow-prune-orphans.test.ts.
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

test("the cog-menu action prunes the leftovers and leaves everything else alone", async () => {
  const window = await readyWindow();
  await createShadowLib(window, shadowDir);

  // The library is empty, so everything planted here is an orphan — exactly the
  // state left behind by albums renamed before the fix.
  const oldAlbum = path.join(shadowDir, "Artist", "Donald");
  fs.mkdirSync(oldAlbum, { recursive: true });
  fs.writeFileSync(path.join(oldAlbum, "01 - Song.mp3"), "x".repeat(1024));
  fs.writeFileSync(path.join(oldAlbum, "cover.jpg"), "art");
  // A file the shadow library has no business reaching.
  const outside = path.join(rootDir, "precious.mp3");
  fs.writeFileSync(outside, "do not touch");

  // Drive the real affordance rather than the channel behind it: the menu item
  // and its confirm gate are the only things the user ever sees, and this is
  // the one path that proves renderer → preload → main is wired end to end.
  await window.click('button:has-text("Library")').catch(() => {});
  const row = window.locator("text=/^Prune \\d+/").first();
  await row.hover({ timeout: 10_000 });

  const cog = window.locator('button[title="More actions"]').first();
  await expect(cog).toBeVisible({ timeout: 10_000 });
  await cog.click();

  const item = window.locator('[role="menuitem"]:has-text("Prune orphan files")');
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  // Deleting files is gated behind a confirmation, which must be honoured.
  await expect(window.locator('text="Prune orphan files?"')).toBeVisible({
    timeout: 5_000,
  });
  await window.locator('button:has-text("Prune files")').click();

  await expect(window.locator("text=/Removed 2 orphaned files/")).toBeVisible({
    timeout: 15_000,
  });

  expect(fs.existsSync(oldAlbum)).toBe(false);
  // The configured shadow folder itself must survive, and so must the file that
  // was never inside it.
  expect(fs.existsSync(shadowDir)).toBe(true);
  expect(fs.existsSync(outside)).toBe(true);
});

/**
 * The second run is the one that would hurt: a prune that treats an
 * already-faithful tree as all-orphan would delete a working shadow library.
 * Driven through the channel directly so the returned counters can be asserted.
 */
test("a shadow library the prune has already cleaned reports nothing to do", async () => {
  const window = await readyWindow();
  const shadowLibId = await createShadowLib(window, shadowDir);

  const stale = path.join(shadowDir, "Artist", "Gone");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "01.mp3"), "stale");

  expect((await prune(window, shadowLibId)).deleted).toBe(1);

  const second = await prune(window, shadowLibId);
  expect(second.deleted).toBe(0);
  expect(second.bytesFreed).toBe(0);
});
