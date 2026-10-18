/**
 * E2E — hybrid devices, from the desktop app.
 *
 * A hybrid device is reachable both here (mount path + USB) and from a browser
 * holding its folder. From the device card the desktop app can:
 *
 *  - let a browser use a local device — only once its USB device is set;
 *  - give a remote device a local side (mount path + USB) and then sync it
 *    here, through the mount, exactly like a local device.
 *
 * The browser side is `web-hybrid-device.test.ts`.
 *
 * Run: npm run build && npx playwright test tests/e2e/hybrid-device.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let root: string;

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

interface Profile {
  id: number;
  connection: string;
  transport: string;
  mountPath: string;
  error?: string;
}

test.beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-hybrid-"));
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

async function readyWindow(): Promise<Page> {
  const window = await launched.app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: { invoke?: unknown } }).api?.invoke === "function",
    null,
    { timeout: 15_000 }
  );
  return window;
}

function invoke<T = unknown>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([c, a]) => (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

async function openDevices(window: Page): Promise<void> {
  await window.getByRole("button", { name: "Devices" }).first().click();
}

function card(window: Page, name: string) {
  return window.locator("div", { has: window.getByRole("heading", { name, exact: true }) }).filter({
    has: window.getByTestId("device-connections"),
  }).last();
}

test("a local device becomes usable from a browser once its USB device is set", async () => {
  const window = await readyWindow();
  const mount = path.join(root, "ipod");
  fs.mkdirSync(mount);
  const d = await invoke<Profile>(window, "device:add", { name: "Desk iPod", mountPath: mount, devMode: true });

  await openDevices(window);
  const c = card(window, "Desk iPod");
  // No USB identity yet: a hybrid device must have one.
  await expect(c.getByTestId("device-allow-browser")).toBeDisabled();

  await invoke(window, "device:update", d.id, {
    usbVendorId: "05ac",
    usbProductId: "1261",
    usbSerial: "DESK1",
  });
  await window.reload();
  await readyWindow();
  await openDevices(window);
  await card(window, "Desk iPod").getByTestId("device-allow-browser").click();
  await expect(card(window, "Desk iPod").getByTestId("device-hybrid-badge")).toBeVisible();
  // Still synced here, through its mount.
  await expect(card(window, "Desk iPod").getByRole("button", { name: "Check Device" })).toBeEnabled();

  await card(window, "Desk iPod").getByTestId("device-stop-browser").click();
  await expect(card(window, "Desk iPod").getByTestId("device-hybrid-badge")).toHaveCount(0);
  const back = (await invoke<Profile[]>(window, "device:list")).find((x) => x.id === d.id)!;
  expect(back.connection).toBe("local");
});

test("a remote device gains a local side and syncs here through it", async () => {
  const window = await readyWindow();
  const lib = path.join(root, "library", "Hybrid Artist", "Hybrid Album");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "01 Track.mp3"), Buffer.alloc(4000, 7));
  const mount = path.join(root, "ipod");
  for (const f of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
    fs.mkdirSync(path.join(mount, f), { recursive: true });
  }
  await invoke(window, "library:addFolder", { name: "Hybrid Lib", path: path.join(root, "library"), contentType: "music" });
  await invoke(window, "library:scan", {
    folders: [{ name: "Hybrid Lib", path: path.join(root, "library"), contentType: "music" }],
  });

  const remote = await invoke<Profile>(window, "device:add", { name: "Browser iPod", transport: "web" });
  expect(remote.connection).toBe("remote");
  // Its USB identity, as the player reports it — so the dialog starts on it.
  await invoke(window, "device:update", remote.id, { usbVendorId: "05ac", usbProductId: "1261", usbSerial: "WEB1" });
  // Dev mode stands in for "plugged in" — there is no real USB unit here.
  await invoke(window, "device:update", remote.id, { devMode: true });

  await openDevices(window);
  // From here the remote device cannot be synced …
  await expect(card(window, "Browser iPod").getByRole("button", { name: "Check Device" })).toBeDisabled();
  await card(window, "Browser iPod").getByTestId("device-add-local").click();
  const dialog = window.getByRole("dialog").filter({ hasText: "Add a local connection" });
  await dialog.getByTestId("hybrid-mount-path").fill(mount);
  // The USB select already shows the saved identity ("Saved device — …").
  await expect(dialog.getByTestId("hybrid-usb-select")).toContainText("Saved device");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(window, "Browser iPod").getByTestId("device-hybrid-badge")).toBeVisible();

  // … now it can, through the mount.
  const result = await invoke<{ errors: number; synced: number; error?: string }>(window, "sync:start", {
    deviceId: remote.id,
    syncType: "full",
    extraTrackPolicy: "keep",
    includeMusic: true,
    includePodcasts: false,
    includeAudiobooks: false,
    includePlaylists: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.synced).toBe(1);
  const copied = fs.readdirSync(path.join(mount, "Music"), { recursive: true }) as string[];
  expect(copied.some((p) => p.endsWith("01 Track.mp3"))).toBe(true);
});
