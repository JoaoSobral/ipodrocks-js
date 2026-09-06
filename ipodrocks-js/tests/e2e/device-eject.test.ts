/**
 * E2E tests for ejecting a device from inside iPodRocks.
 *
 * Drives the real built app through the IPC bridge (renderer → preload → main).
 * Every assertion is hardware-independent: no test here ever ejects anything.
 * What they pin is the set of guards that stand between the button and
 * `diskutil eject` — because the failure mode that matters is iPodRocks handing
 * an ordinary folder to an eject command, not an eject that does not happen.
 *
 * Command-building and /proc/mounts parsing live in
 * src/__tests__/device-eject.test.ts; the Rocksy tool classification in
 * src/__tests__/assistant-tools.test.ts.
 *
 * Run: npm run build && npx playwright test
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { launchApp, type LaunchedApp } from "./electron-launcher";

// Windows has no eject path at all — the handler refuses and the button is
// hidden, so there is nothing here to assert.
test.skip(process.platform === "win32", "Eject is macOS/Linux only");

let launched: LaunchedApp;
const tmpDirs: string[] = [];

// One app for the file; each test creates its own device and looks the result up
// by the id it got back, so the rows the others leave behind cannot confuse it.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Seed the MPC reminder as dismissed: its modal auto-opens on hosts without
  // mpcenc and its backdrop swallows clicks on the device cards.
  launched = await launchApp(undefined, { seedPrefs: { mpcRemindDisabled: true } });
});

test.afterAll(async () => {
  await launched.cleanup();
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

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

type Api = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  platform: string;
};

type EjectResult = { ejected?: boolean; name?: string; error?: string };

async function addAndEject(
  window: Page,
  config: Record<string, unknown>
): Promise<EjectResult> {
  return window.evaluate(async (cfg) => {
    const api = (window as unknown as { api: Api }).api;
    const added = (await api.invoke("device:add", cfg)) as { id: number };
    return (await api.invoke("device:eject", added.id)) as EjectResult;
  }, config);
}

test("the preload bridge exposes the host platform", async () => {
  const window = await readyWindow();
  const platform = await window.evaluate(
    () => (window as unknown as { api: Api }).api.platform
  );
  // This is what hides the button on Windows; without it the button would be
  // offered everywhere and simply fail.
  expect(platform).toBe(process.platform);
});

test("a dev-mode device is refused — there is no volume to eject", async () => {
  const window = await readyWindow();
  const mountPath = makeTmpDir("ipr-e2e-eject-dev-");

  const result = await addAndEject(window, {
    name: `Eject DevMode ${Date.now()}`,
    mountPath,
    devMode: true,
  });

  expect(result.ejected).toBeUndefined();
  expect(result.error).toMatch(/dev-mode/i);
  // The guard must not have touched the folder on its way to refusing.
  expect(fs.existsSync(mountPath)).toBe(true);
});

/**
 * The load-bearing assertion of this file. A device profile can point at any
 * directory, and `isDeviceMountPathOnline`'s st_dev-vs-parent check is the only
 * thing distinguishing a real volume from a plain folder — or from the orphan
 * directory macOS leaves behind after a previous eject. If this regresses,
 * iPodRocks runs `diskutil eject` against an arbitrary path.
 */
test("an ordinary folder is refused as not mounted", async () => {
  const window = await readyWindow();
  const mountPath = makeTmpDir("ipr-e2e-eject-plain-");
  fs.writeFileSync(path.join(mountPath, "canary.txt"), "still here");

  const result = await addAndEject(window, {
    name: `Eject Unmounted ${Date.now()}`,
    mountPath,
  });

  expect(result.ejected).toBeUndefined();
  expect(result.error).toMatch(/not mounted/i);
  expect(fs.existsSync(mountPath)).toBe(true);
  expect(fs.readFileSync(path.join(mountPath, "canary.txt"), "utf8")).toBe("still here");
});

test("ejecting an unknown device id reports not found, never a crash", async () => {
  const window = await readyWindow();
  const result = await window.evaluate(
    async () =>
      (await (window as unknown as { api: Api }).api.invoke(
        "device:eject",
        999_999
      )) as EjectResult
  );
  expect(result.error).toMatch(/not found/i);
});

test("the Eject button appears in the device card and surfaces the refusal", async () => {
  const window = await readyWindow();
  const mountPath = makeTmpDir("ipr-e2e-eject-ui-");
  const name = `Eject UI ${Date.now()}`;

  await window.evaluate(async (cfg) => {
    const api = (window as unknown as { api: Api }).api;
    await api.invoke("device:add", cfg);
  }, { name, mountPath });

  await window.getByRole("button", { name: "Devices" }).first().click();

  // Climb from this device's heading to the nearest enclosing card, so the
  // button we click is unambiguously the one on *this* device's card.
  const card = window
    .getByRole("heading", { name })
    .locator("xpath=ancestor::div[.//button[normalize-space()='Eject']][1]");
  const ejectButton = card.getByRole("button", { name: "Eject", exact: true });
  await expect(ejectButton).toBeVisible({ timeout: 15_000 });

  await ejectButton.click();

  // The handler returns errors as data, so the panel must read `.error` and
  // toast it rather than relying on a rejected promise.
  await expect(window.getByText(/not mounted/i).first()).toBeVisible({ timeout: 10_000 });
});
