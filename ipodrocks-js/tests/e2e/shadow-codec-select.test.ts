/**
 * Playwright E2E — Create Shadow Library codec dropdown (regression for #91)
 *
 * The "Musepack not selectable" bug was caused by the shared <Select> dropdown
 * rendering its option list past the bottom of the window (options in the lower
 * part of the list — where the MPC configs sit alphabetically — became
 * unclickable). This test constrains the window so the codec select sits low in
 * the viewport, opens its dropdown, and asserts:
 *   1. the option list is fully within the visible window, and
 *   2. the last (deepest) option is scrollable-into-view and selectable.
 *
 * When mpcenc is available on the host, it additionally asserts an "MPC" option
 * exists and can be chosen (the encoder is filtered out when mpcenc is missing).
 *
 * Run with: `npm run build && npx playwright test`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let seedDir: string;

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-shadow-"));
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

test("codec dropdown stays within the window and all options are selectable", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Seed a folder so the Library panel renders its content (incl. the Shadow
  // Libraries card) instead of the empty state.
  await window.evaluate(
    (folderPath) =>
      (window as unknown as { api: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).api.invoke(
        "library:addFolder",
        { name: "E2E Seed", path: folderPath, contentType: "music" }
      ),
    seedDir
  );

  const libraryNav = window.locator('[data-panel="library"], [data-testid="nav-library"], button:has-text("Library")').first();
  if (await libraryNav.isVisible()) {
    await libraryNav.click();
  }

  // Shrink the window so the codec select sits low in the viewport, recreating
  // the not-enough-space-below condition that clipped the dropdown. minHeight is
  // 600 in main, so lower the minimum first.
  await launched.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setMinimumSize(900, 360);
    w.setContentSize(1100, 440);
  });

  // Open the Create Shadow Library modal.
  await window.locator('button:has-text("+ Create")').first().click();
  await window.getByRole("dialog").filter({ hasText: "Create Shadow Library" }).waitFor({ timeout: 10_000 });

  // When mpcenc is missing a "Musepack unavailable" reminder modal appears over
  // the dialog; dismiss just that modal (scoped to its dialog) so it doesn't
  // cover the codec select.
  const mpcReminder = window.getByRole("dialog").filter({ hasText: "Musepack (MPC) unavailable" });
  if (await mpcReminder.isVisible().catch(() => false)) {
    await mpcReminder.getByRole("button", { name: "OK" }).click().catch(() => undefined);
  }

  const codecSelect = window.locator('[data-testid="shadow-codec-select"]');
  await expect(codecSelect).toBeVisible({ timeout: 10_000 });
  await codecSelect.scrollIntoViewIfNeeded();

  // The container also holds the tooltip's "More info" button, so target the
  // select's own trigger button explicitly.
  const trigger = codecSelect.locator('button:not([aria-label="More info"])').first();

  // Open the dropdown.
  await trigger.click();
  const listbox = window.locator('[role="listbox"]');
  await expect(listbox).toBeVisible();

  // (1) The option list must be fully inside the visible window.
  const innerHeight = await window.evaluate(() => window.innerHeight);
  const box = await listbox.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(innerHeight + 1);

  // (2) The deepest option must be reachable and selectable.
  const options = listbox.locator('[role="option"]');
  const count = await options.count();
  expect(count).toBeGreaterThan(1);
  const last = options.nth(count - 1);
  await last.scrollIntoViewIfNeeded();
  const lastLabel = (await last.textContent())?.trim() ?? "";
  await last.click();
  await expect(trigger).toContainText(lastLabel);

  // (3) When mpcenc is available, Musepack must be present and choosable.
  const mpc = await window.evaluate(
    () =>
      (window as unknown as { api: { invoke: (c: string) => Promise<{ available: boolean }> } }).api.invoke(
        "app:isMpcencAvailable"
      )
  );
  if (mpc.available) {
    await trigger.click();
    const mpcOption = listbox.locator('[role="option"]', { hasText: /MPC/i }).first();
    await expect(mpcOption).toHaveCount(1);
    await mpcOption.scrollIntoViewIfNeeded();
    const mpcBox = await mpcOption.boundingBox();
    expect(mpcBox).not.toBeNull();
    // The MPC option must render within the visible window (the core bug).
    expect(mpcBox!.y).toBeGreaterThanOrEqual(0);
    expect(mpcBox!.y + mpcBox!.height).toBeLessThanOrEqual((await window.evaluate(() => window.innerHeight)) + 1);
    await mpcOption.click();
    await expect(trigger).toContainText(/MPC/i);
  }
});
