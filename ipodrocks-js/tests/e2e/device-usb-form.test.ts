/**
 * E2E for the USB Device field in the Add/Edit Device form.
 *
 * Complements device-usb-identity.test.ts (which exercises the IPC/DB layer) by
 * driving the real Devices panel. Deliberately makes no assertion about which
 * USB devices appear — CI runners have none and dev machines have many — only
 * that the control exists, defaults to "not set", and stays optional.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;

test.beforeEach(async () => {
  launched = await launchApp();
});
test.afterEach(async () => {
  await launched.cleanup();
});

/**
 * Open the Devices panel and the Add Device modal.
 *
 * On hosts without `mpcenc` the panel auto-opens an "MPC unavailable" reminder
 * whose backdrop swallows clicks; `waitFor()` polls (unlike `isVisible()`) so
 * the modal settles before we decide whether to dismiss it. See device-add.test.ts.
 */
async function openAddDeviceForm(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await window.locator('button:has-text("Devices"), a:has-text("Devices")').first().click();

  const mpcModal = window.locator('div[role="dialog"]:has-text("Musepack (MPC) unavailable")');
  const appeared = await mpcModal
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await mpcModal.locator('button[title="Close"]').click();

  await window.locator('button:has-text("+ Add Device")').first().click();
}

test("the USB Device field renders and defaults to mount-path matching", async () => {
  const window = await launched.app.firstWindow();
  await openAddDeviceForm(window);

  const usbSelect = window.getByTestId("usb-device-select");
  await expect(usbSelect).toBeVisible();

  // Default state tells the user what happens when they leave it alone.
  await expect(
    usbSelect.locator('button:has-text("Not set — match by mount path only")')
  ).toBeVisible();

  // The rescan control is present — users plug the device in after opening this.
  await expect(window.locator('button:text-is("Refresh")')).toBeVisible();
});

test("the USB list always offers a way back to mount-path matching", async () => {
  const window = await launched.app.firstWindow();
  await openAddDeviceForm(window);

  // Target the trigger by its text — the field's tooltip icon is a button too.
  await window
    .getByTestId("usb-device-select")
    .locator('button:has-text("Not set — match by mount path only")')
    .click();

  // Whatever hardware this runs on, the "not set" escape hatch is option one.
  const options = window.locator('[role="option"]');
  await expect(options.first()).toHaveText(/Not set — match by mount path only/);
});

test("a device can still be added without touching the USB field", async () => {
  const window = await launched.app.firstWindow();
  await openAddDeviceForm(window);

  const name = `NoUsbDevice${Date.now()}`;
  await window.locator('input[placeholder="My iPod"]').fill(name);
  await window.locator('button:has-text("Select a model…")').first().click();
  await window.locator('[role="option"]').nth(1).click();
  await window.locator('input[placeholder="/mnt/ipod"]').fill("/tmp/ipr-usb-form");

  await window.locator('button:text-is("Add Device")').click();

  // The modal closes on success, and the device lands with no USB identity.
  await expect(window.locator('button:text-is("Add Device")')).toBeHidden({ timeout: 10_000 });

  const stored = await window.evaluate(async (deviceName: string) => {
    const api = (window as unknown as {
      api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
    }).api;
    const list = (await api.invoke("device:list")) as Array<{
      name: string;
      usbVendorId?: string | null;
    }>;
    return list.find((d) => d.name === deviceName);
  }, name);

  expect(stored).toBeTruthy();
  expect(stored?.usbVendorId).toBeNull();
});
