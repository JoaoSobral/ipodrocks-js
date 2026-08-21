/**
 * Playwright e2e — Dashboard "Recent Activity" card stays visible.
 *
 * Regression guard: the Dashboard grid used to size its last row as `1fr`
 * inside a fixed-height (`h-full`) container, with the Recent Activity card
 * filling that row via its own `flex-1 min-h-0 overflow-y-auto` list. Adding
 * the Listening Stats card (a tall `auto` row) between Shadow Libraries and
 * Recent Activity starved that `1fr` row down to near-zero — the card's
 * title rendered, but its list of entries collapsed to ~0px height and was
 * never visible, no matter how far the page was scrolled. The fix drops the
 * `h-full`/`1fr` grid entirely (all rows `auto`, page scrolls naturally) and
 * gives Recent Activity's list a fixed `max-h-96` instead of depending on
 * leftover grid space.
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

let launched: LaunchedApp;
let seedDir: string;

test.beforeEach(async () => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-activity-"));
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

test("Recent Activity entries render with real, visible height after a scan", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  fs.writeFileSync(path.join(seedDir, "Track.mp3"), Buffer.from("fake-audio-bytes"));

  // Produces a real `library_scan` Recent Activity row.
  await window.evaluate(
    (folderPath) =>
      (window as unknown as ApiWindow).api.invoke("library:scan", {
        folders: [{ name: "E2E Activity Seed", path: folderPath, contentType: "music" }],
      }),
    seedDir
  );

  const dashboardNav = window
    .locator('[data-panel="dashboard"], [data-testid="nav-dashboard"], button:has-text("Dashboard")')
    .first();
  await dashboardNav.click();

  // Role-scoped: getByText does case-insensitive substring matching, so a plain
  // "Recent Activity" also matches the "No recent activity" empty state and
  // fails strict mode with a confusing two-element error instead of a real one.
  await expect(window.getByRole("heading", { name: "Recent Activity" })).toBeVisible();

  // The regression: this row used to exist in the DOM with ~0px height,
  // which `toBeVisible()` alone does not catch (visibility passes even for
  // a 0-height, non-zero-width box in some cases) — assert real height too.
  const firstEntry = window.locator("text=Library scan").first();
  await expect(firstEntry).toBeVisible();
  const box = await firstEntry.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(5);
});
