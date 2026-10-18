/**
 * E2E — keeping the library current on startup (desktop).
 *
 *  - Settings → Library → "Scan library at startup" is off by default; with it
 *    on, opening the app starts a scan.
 *  - With it off, a library that has gone 10 days without a scan (or was never
 *    scanned) is met with "You haven't scanned your library since …" — Yes
 *    scans, No keeps it quiet for another 10 days.
 *
 * "Opening the app" is a renderer reload: the check runs once per load, and a
 * relaunch would also throw away the user-data directory the harness made.
 *
 * Run: npm run build && npx playwright test tests/e2e/library-scan-reminder.test.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

let launched: LaunchedApp;
let musicDir: string;

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

test.beforeEach(async () => {
  musicDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-scanrem-"));
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
  fs.rmSync(musicDir, { recursive: true, force: true });
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

/** A library folder that has never been scanned, then "open the app again". */
async function unscannedLibraryAndReopen(window: Page): Promise<void> {
  await invoke(window, "library:addFolder", { name: "Reminder Lib", path: musicDir, contentType: "music" });
  await window.reload();
  await readyWindow();
}

test("a library never scanned is met with the reminder; No keeps it quiet", async () => {
  const window = await readyWindow();
  // No folders yet: nothing to ask about.
  await expect(window.getByTestId("scan-reminder")).toHaveCount(0);

  await unscannedLibraryAndReopen(window);
  const reminder = window.getByTestId("scan-reminder");
  await expect(reminder).toBeVisible({ timeout: 10_000 });
  await expect(reminder).toContainText("Your library has not been scanned yet.");
  await expect(reminder).toContainText("Do you wish to scan it now?");
  await reminder.getByRole("button", { name: "No" }).click();
  await expect(reminder).toHaveCount(0);

  // Asked again only after another 10 days.
  await window.reload();
  await readyWindow();
  await expect(window.getByRole("button", { name: "Sync", exact: true })).toBeVisible();
  await expect(window.getByTestId("scan-reminder")).toHaveCount(0);
  const r = await invoke<{ due: boolean }>(window, "library:getScanReminder");
  expect(r.due).toBe(false);
});

test("Yes scans the library, and the reminder then has nothing to say", async () => {
  const window = await readyWindow();
  await unscannedLibraryAndReopen(window);
  const reminder = window.getByTestId("scan-reminder");
  await expect(reminder).toBeVisible({ timeout: 10_000 });
  await reminder.getByRole("button", { name: "Yes" }).click();

  await expect
    .poll(async () => (await invoke<{ lastScanAt: string | null }>(window, "library:getScanReminder")).lastScanAt, {
      timeout: 30_000,
    })
    .not.toBeNull();
});

test("with 'Scan library at startup' on, opening the app scans and does not ask", async () => {
  const window = await readyWindow();
  await invoke(window, "library:addFolder", { name: "Reminder Lib", path: musicDir, contentType: "music" });

  await window.getByRole("button", { name: "Settings" }).click();
  const toggle = window.getByTestId("scan-on-startup");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await window.getByRole("button", { name: "Save", exact: true }).click();
  await window.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10_000 });
  expect(await invoke(window, "settings:getLibraryPrefs")).toEqual({ scanOnStartup: true });

  await window.reload();
  await readyWindow();
  await expect
    .poll(async () => (await invoke<{ lastScanAt: string | null }>(window, "library:getScanReminder")).lastScanAt, {
      timeout: 30_000,
    })
    .not.toBeNull();
  await expect(window.getByTestId("scan-reminder")).toHaveCount(0);
});
