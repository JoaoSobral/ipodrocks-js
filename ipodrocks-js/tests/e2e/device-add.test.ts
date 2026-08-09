/**
 * E2E for the Add Device flow — regression for issue #98.
 *
 * The main-process `safe()` wrapper returns validation failures as data
 * ({ error }) rather than rejecting, so the modal used to close silently on a
 * rejected add ("nothing happens"). This drives the real Devices panel form and
 * asserts a rejected submit now surfaces the error and keeps the modal open.
 *
 * The POSIX filesystem root `/` is rejected by sanitizeMountPath; on Windows a
 * drive root is instead *accepted* (that's the actual fix), so this UI-error
 * check is POSIX-only. Windows drive-root acceptance is covered by the unit and
 * behavior tests.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
});

test.skip(
  process.platform === "win32",
  "`/` is a valid drive-relative path on Windows; root rejection is POSIX-only"
);

test("rejected add (filesystem root) shows an error instead of closing silently", async () => {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  // Navigate to the Devices panel via the sidebar.
  await window.locator('button:has-text("Devices"), a:has-text("Devices")').first().click();

  // On hosts without `mpcenc` (e.g. CI runners), DevicePanel auto-opens an
  // "MPC unavailable" reminder once its two mount-time IPC round trips
  // (isMpcencAvailable, getMpcRemindDisabled) resolve, and its backdrop
  // blocks every other click. `isVisible()` does not poll — it was racing
  // those IPC calls and losing on slower CI/xvfb runners, so the modal was
  // popping in mid-click on "+ Add Device" instead of being dismissed first.
  // `waitFor()` actually polls, so wait for the modal to settle one way or
  // the other before deciding whether to dismiss it.
  const mpcModal = window.locator('div[role="dialog"]:has-text("Musepack (MPC) unavailable")');
  const mpcModalAppeared = await mpcModal
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (mpcModalAppeared) {
    await mpcModal.locator('button[title="Close"]').click();
  }

  // Open the Add Device modal.
  await window.locator('button:has-text("+ Add Device")').first().click();

  // Name.
  await window.locator('input[placeholder="My iPod"]').fill("RootTestDevice");

  // Model is required client-side — open the custom Select and pick the first
  // real model (index 0 is the "Select a model…" placeholder option).
  await window.locator('button:has-text("Select a model…")').first().click();
  await window.locator('[role="option"]').nth(1).click();

  // Mount Path = filesystem root, which the main process rejects.
  await window.locator('input[placeholder="/mnt/ipod"]').fill("/");

  // Submit (modal button is exactly "Add Device", the header ones are "+ Add Device").
  await window.locator('button:text-is("Add Device")').click();

  // The error is surfaced (sonner toast) ...
  await expect(window.locator("text=/filesystem root/i").first()).toBeVisible({
    timeout: 10_000,
  });

  // ... and the modal stays open (submit button still present) instead of
  // silently closing.
  await expect(window.locator('button:text-is("Add Device")')).toBeVisible();
});
