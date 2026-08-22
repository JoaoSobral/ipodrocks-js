/**
 * E2E for the update-check rate limit (manual checks, capped at 4/hour — see
 * checkRateLimit in src/main/utils/update-checker.ts). Confirms the cap is
 * enforced through the real "Check for updates" button on the Welcome panel,
 * not just at the unit level — and that the automatic check-on-mount does not
 * eat into that budget, which used to leave the button stuck on "Try again
 * later" after a few visits to the tab.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

const BUTTON = ".absolute.top-2.right-2 button";
const SPINNER = ".absolute.top-2.right-2 svg.animate-spin";

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.cleanup();
});

test("a manual update check past the hourly cap is refused instead of hitting the network", async () => {
  const now = Date.now();
  launched = await launchApp(undefined, {
    seedPrefs: {
      // The whole 4/hour manual budget is already spent.
      updateCheckTimestamps: [now - 1_000, now - 2_000, now - 3_000, now - 4_000],
      // Automatic check already done today, so nothing touches the network.
      lastAutoUpdateCheckAt: now - 1_000,
    },
  });
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const button = window.locator(BUTTON).first();
  await button.click();
  await expect(button).toHaveText("Try again later", { timeout: 3_000 });
  await expect(button).toHaveAttribute(
    "title",
    "Checked too many times this hour — try again later"
  );
});

test("the automatic check on mount leaves the manual budget intact", async () => {
  const now = Date.now();
  launched = await launchApp(undefined, {
    seedPrefs: {
      // 3 manual checks spent; one slot left. No lastAutoUpdateCheckAt, so the
      // automatic check on mount runs for real — it must not take that slot.
      updateCheckTimestamps: [now - 1_000, now - 2_000, now - 3_000],
    },
  });
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  const button = window.locator(BUTTON).first();

  // Wait out the automatic check's network round trip (bounded by the main
  // process's own 10s fetch timeout) before driving the click.
  await window
    .locator(SPINNER)
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);

  await button.click();
  await window.locator(SPINNER).waitFor({ state: "hidden", timeout: 15_000 });
  // Whatever the network says ("✓ Up to date" / "Could not check" / an update
  // modal), the one thing this settled click must not be is rate-limited.
  await expect(button).not.toHaveText("Try again later");
});
