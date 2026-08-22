/**
 * E2E for the update-check rate limit (manual checks, capped per hour by
 * UPDATE_CHECK_RATE_LIMIT — see checkRateLimit in
 * src/main/utils/update-checker.ts). Confirms the cap is enforced through the
 * real "Check for updates" button on the Welcome panel, not just at the unit
 * level — and that the automatic check-on-mount does not eat into that budget,
 * which used to leave the button stuck on "Try again later" after a few visits
 * to the tab.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";
import { UPDATE_CHECK_RATE_LIMIT } from "../../src/main/utils/update-checker";

const BUTTON = ".absolute.top-2.right-2 button";
const SPINNER = ".absolute.top-2.right-2 svg.animate-spin";

/** `count` check timestamps inside the rolling window, newest first. */
const spentChecks = (now: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => now - (i + 1) * 1_000);

let launched: LaunchedApp;

test.afterEach(async () => {
  await launched?.cleanup();
});

test("a manual update check past the hourly cap is refused instead of hitting the network", async () => {
  const now = Date.now();
  launched = await launchApp(undefined, {
    seedPrefs: {
      // The whole hourly manual budget is already spent.
      updateCheckTimestamps: spentChecks(now, UPDATE_CHECK_RATE_LIMIT),
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
