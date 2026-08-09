/**
 * E2E for the update-check rate limit (auto + manual checks combined,
 * capped at 4/hour — see checkRateLimit in
 * src/main/utils/update-checker.ts). Confirms the cap is enforced through
 * the real "Check for updates" button on the Welcome panel, not just at
 * the unit level.
 *
 * The app already burns one check on mount (the automatic check in
 * WelcomePanel), so we seed prefs with 3 recent timestamps before launch —
 * leaving exactly one slot, which the automatic check consumes. That way
 * the assertion doesn't have to wait through several real network round
 * trips to GitHub: the first manual click after mount is the one guaranteed
 * to be denied, and a denied check never touches the network, so it
 * resolves immediately regardless of network conditions.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.cleanup();
});

test("the 5th update check within an hour is rate-limited instead of hitting the network", async () => {
  const now = Date.now();
  launched = await launchApp(undefined, {
    seedPrefs: {
      // 3 recent checks already spent; only 1 of the 4/hour budget remains.
      updateCheckTimestamps: [now - 1_000, now - 2_000, now - 3_000],
    },
  });
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const button = window.locator(".absolute.top-2.right-2 button").first();

  // The Welcome panel's automatic check-on-mount consumes the last slot.
  // Wait for its spinner to clear (bounded by the main process's own 10s
  // fetch timeout, since this is a real network round trip) before driving
  // the next click.
  await window
    .locator(".absolute.top-2.right-2 svg.animate-spin")
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);

  // This manual click is the 5th check — denied before any fetch happens,
  // so it settles fast regardless of network reachability.
  await button.click();
  await expect(button).toHaveText("Try again later", { timeout: 3_000 });
  await expect(button).toHaveAttribute(
    "title",
    "Checked too many times this hour — try again later"
  );
});
