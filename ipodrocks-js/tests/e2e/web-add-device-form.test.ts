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
import { invoke, removeDeviceRow, signIn, signInPage } from "./web-harness";

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

  // And it says what it is instead. The long explanation moved into the
  // heading's tooltip — as body text it was four lines of prose above the one
  // control that matters — so what is asserted here is the label and the
  // control, not the prose.
  await expect(dialog.getByText("Remote device", { exact: true })).toBeVisible();
});

test("the Add form offers the browser's own folder picker", async ({ page }) => {
  await openDevices(page);
  await page.getByRole("button", { name: "+ Add Remote Device" }).first().click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Add Remote Device" });
  // The folder *is* pickable here — from this machine, through the browser.
  // `showDirectoryPicker()` itself is a user-gesture-gated native dialog no
  // test can drive, so what is pinned is that the control exists and says what
  // it is for; the File System Access path beyond it is covered by
  // `web-device-sync.test.ts` against an OPFS handle.
  await expect(dialog.getByRole("button", { name: "Choose folder" })).toBeVisible();
  await expect(dialog.getByText("No folder chosen")).toBeVisible();
  // ...and it is optional, because the card's Connect button is the other way in.
  await expect(dialog).toContainText("connect it from its card later");
});

test("the Add form hides the server's USB list", async ({ page }) => {
  await openDevices(page);
  await page.getByRole("button", { name: "+ Add Remote Device" }).first().click();

  const dialog = page.getByRole("dialog").filter({ hasText: "Add Remote Device" });
  // That dropdown enumerates the *server's* USB bus, which says nothing about
  // the player in the user's hand. Left visible it was an always-empty select
  // above a red "Could not read USB devices on this system" — true, and
  // entirely beside the point.
  await expect(dialog.getByText("USB Device (optional)")).toHaveCount(0);
  await expect(dialog.getByText(/Could not read USB devices/)).toHaveCount(0);
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

test("the server refuses a web client's edit or delete of a server-side device", async ({
  request,
}) => {
  await signIn(request);
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: "E2E Admin Guard",
    mountPath: "/tmp/ipr-e2e-adminguard",
    transport: "local",
  });

  try {
    // The disabled buttons are a courtesy; these are the guard. Without them a
    // browser could rename or delete the configuration of a player it cannot
    // see and could never verify.
    const updated = await invoke<{ error?: string }>(request, "device:update", device.id, {
      name: "Renamed From The Web",
    });
    expect(updated.error).toMatch(/machine running the server/i);

    const removed = await invoke<{ error?: string }>(request, "device:remove", device.id);
    expect(removed.error).toMatch(/machine running the server/i);

    const list = await invoke<{ id: number; name: string }[]>(request, "device:list");
    expect(list.find((d) => d.id === device.id)?.name).toBe("E2E Admin Guard");
  } finally {
    removeDeviceRow(device.id);
  }
});

test("a remote device is badged, and a server-side one is not", async ({
  page,
  request,
}) => {
  await signIn(request);
  const remote = await invoke<{ id: number }>(request, "device:add", {
    name: "E2E Badge Remote",
    transport: "web",
  });
  const local = await invoke<{ id: number }>(request, "device:add", {
    name: "E2E Badge Local",
    mountPath: "/tmp/ipr-e2e-badge",
    transport: "local",
  });

  try {
    await openDevices(page);
    // Which machine a device is plugged into changes what its card can do, and
    // is otherwise legible only from what is missing.
    await expect(page.getByText("REMOTE", { exact: true })).toHaveCount(1);
  } finally {
    await invoke(request, "device:remove", remote.id);
    removeDeviceRow(local.id);
  }
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
    // ...and its settings belong to the machine it is plugged into, so a
    // browser may not edit or delete them either.
    await expect(page.getByRole("button", { name: "Edit" }).first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Remove" }).first()).toBeDisabled();
  } finally {
    // Removed straight from the database: the point of the test is that the
    // web client cannot do this, so it cannot be the thing that cleans up.
    removeDeviceRow(device.id);
  }
});
