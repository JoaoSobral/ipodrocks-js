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

// One app for the whole file: none of these tests depend on the state the
// others leave behind, and an Electron cold start costs more than every
// assertion here put together.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // DevicePanel auto-opens an "MPC unavailable" reminder on hosts without
  // `mpcenc`, and its backdrop swallows clicks. Seeding the "don't remind me"
  // pref means the modal cannot appear at all, so the form helper below does
  // not have to spend 8s waiting to find out whether it did.
  launched = await launchApp(undefined, { seedPrefs: { mpcRemindDisabled: true } });
});
test.afterAll(async () => {
  await launched.cleanup();
});

/** Open the Devices panel and the Add Device modal. */
async function openAddDeviceForm(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await window.locator('button:has-text("Devices"), a:has-text("Devices")').first().click();
  await window.locator('button:has-text("+ Add Device")').first().click();
}

/** Close the Add Device modal so the next test starts from the panel. */
async function closeAddDeviceForm(window: Page): Promise<void> {
  await window.locator('button:text-is("Cancel")').first().click();
  await window.locator('button:text-is("Add Device")').waitFor({ state: "hidden" });
}

test("the USB field defaults to mount-path matching and always offers it back", async () => {
  const window = await launched.app.firstWindow();
  await openAddDeviceForm(window);

  const usbSelect = window.getByTestId("usb-device-select");
  await expect(usbSelect).toBeVisible();

  // Default state tells the user what happens when they leave it alone.
  // Target the trigger by its text — the field's tooltip icon is a button too.
  const trigger = usbSelect.locator(
    'button:has-text("Not set — match by mount path only")'
  );
  await expect(trigger).toBeVisible();

  // The rescan control is present — users plug the device in after opening this.
  await expect(window.locator('button:text-is("Refresh")')).toBeVisible();

  // Whatever hardware this runs on, the "not set" escape hatch is option one,
  // so a user who binds the wrong unit can always get back to where they were.
  await trigger.click();
  const options = window.locator('[role="option"]');
  await expect(options.first()).toHaveText(/Not set — match by mount path only/);

  // Picking it closes the dropdown and leaves the field where it started.
  await options.first().click();
  await expect(trigger).toBeVisible();

  await closeAddDeviceForm(window);
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
