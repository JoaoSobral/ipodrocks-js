/**
 * Playwright E2E — the Add Device form, as a browser actually renders it.
 *
 * Everything about remote devices so far has been pinned at the handler: the
 * locality guard, the dialog refusal, the auto-podcast block. All of that is
 * real, and none of it looks at a single pixel — which is how the *reported*
 * symptom survived two rounds of fixes.
 *
 * What the user sees is decided by `isWebMode()`, and that predicate was
 * written as "there is no preload" (`window.api === undefined`). True at
 * bootstrap, which is where `main.tsx` asks it — and false immediately
 * afterwards, because `installWebTransport()` *installs* `window.api`. So every
 * caller that runs after React mounts got "no, this is Electron", and the
 * browser's Devices panel duly offered a server **Mount Path** with a Browse
 * button and labelled itself "Add Device".
 *
 * No handler test could see that, and no handler was wrong. This spec renders
 * the panel and reads it.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect } from "@playwright/test";
import { invoke, signIn, signInPage } from "./web-harness";

test.describe.configure({ mode: "serial" });

/** Opens the app, signed in, on the Devices panel. */
async function openDevices(page: import("@playwright/test").Page) {
  await signInPage(page);
  await page.goto("/");
  await page.waitForFunction(
    () => typeof (window as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 20_000 }
  );
  await page.getByRole("button", { name: "Devices" }).first().click();
  await expect(page.getByRole("button", { name: /Add (Remote )?Device/ }).first()).toBeVisible();
}

test("the browser offers to add a remote device, not a device", async ({ page }) => {
  await openDevices(page);

  // The reported symptom, in one assertion.
  await expect(page.getByRole("button", { name: "+ Add Remote Device" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "+ Add Device", exact: true })).toHaveCount(0);
});

test("the Add form asks for no folder on the server", async ({ page }) => {
  await openDevices(page);
  await page.getByRole("button", { name: "+ Add Remote Device" }).first().click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Add Remote Device" });
  await expect(dialog).toBeVisible();

  // The whole point of web mode: the player is on *this* machine, so there is
  // no path on the server to type and nothing to browse for. A Browse button
  // here opens the server's own filesystem — which is what sent the reporter
  // hunting for their iPod on the NAS.
  // `exact` matters: `getByText` is case-insensitive and substring by default,
  // and the USB dropdown legitimately says "match by mount path only".
  await expect(dialog.getByText("Mount Path", { exact: true })).toHaveCount(0);
  await expect(dialog.getByPlaceholder("/mnt/ipod")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Browse" })).toHaveCount(0);

  // And it says what it is instead.
  await expect(dialog.getByText("Remote device", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("pick its folder in this browser");
});

test("Auto Podcasts is disabled in the Add form", async ({ page }) => {
  await openDevices(page);
  await page.getByRole("button", { name: "+ Add Remote Device" }).first().click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Add Remote Device" });
  const autoPodcasts = dialog
    .locator("label")
    .filter({ hasText: "Auto Podcasts" })
    .locator('input[type="checkbox"]');
  await expect(autoPodcasts).toBeDisabled();
  await expect(dialog).toContainText("only connected while its browser tab is open");
});

test("a server-side device is listed but not operable from the browser", async ({
  page,
  request,
}) => {
  await signIn(request);
  // What the desktop app would have created. The browser must show it — hiding
  // it reads as "iPodRocks lost my iPod" — but offer nothing that touches it.
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: "E2E Server Side Player",
    mountPath: "/tmp/ipr-e2e-serverside",
    transport: "local",
  });

  try {
    await openDevices(page);
    await expect(page.getByText("E2E Server Side Player")).toBeVisible();
    await expect(page.getByText(/plugged into the server/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Check Device" }).first()
    ).toBeDisabled();
    // Still removable from either side: it is the user's device either way.
    await expect(page.getByRole("button", { name: "Remove" }).first()).toBeEnabled();
  } finally {
    await invoke(request, "device:remove", device.id);
  }
});
