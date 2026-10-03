/**
 * Playwright E2E — managing web server accounts from the desktop app's
 * Settings → Web Server card.
 *
 * The desktop window is the machine holding the database, so it is the owner
 * without signing in. That makes it the forgotten-password answer for anyone
 * who has it: create the owner, add a local account, set a password, remove
 * the account — all through the rendered card, not just the channels.
 *
 * The new password is then proven the only way that means anything: the
 * server is started and a real login is made against it.
 */
import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

interface ApiWindow {
  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
}

const PORT = 8783;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OWNER_PASSWORD = "the-desktop-owner-password";
const GUEST_PASSWORD = "the-first-guest-password";
const GUEST_RESET = "the-guest-reset-password";

let launched: LaunchedApp;

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

function invoke<T>(window: Page, channel: string, ...args: unknown[]): Promise<T> {
  return window.evaluate(
    ([c, a]) => (window as unknown as ApiWindow).api.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const
  ) as Promise<T>;
}

async function loginStatus(username: string, password: string): Promise<number> {
  const ctx = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const res = await ctx.post("/api/auth/local/login", { data: { username, password } });
  await ctx.dispose();
  return res.status();
}

test.beforeEach(async () => {
  launched = await launchApp();
});

test.afterEach(async () => {
  await launched.cleanup();
});

test("the desktop creates the owner, adds an account, resets its password and removes it", async () => {
  const window = await readyWindow();

  // The listener is not needed for any of the account management, only for
  // the login that proves the result at the end.
  await invoke(window, "server:setConfig", { host: "127.0.0.1", port: PORT, publicUrl: "" });
  const started = await invoke<{ running: boolean; lastError?: string }>(window, "server:start");
  expect(started.running, started.lastError).toBe(true);

  await window.getByRole("button", { name: "Settings" }).click();
  const claim = window.getByTestId("claim-owner");
  await claim.waitFor({ timeout: 10_000 });
  await claim.locator("#owner-username").fill("Desk Owner");
  await claim.locator("#owner-password").fill(OWNER_PASSWORD);
  await claim.getByRole("button", { name: "Create owner account" }).click();

  // Claimed: the claim box is gone and the allowlist is up, with the owner on it.
  const allowlist = window.getByTestId("sign-in-allowlist");
  await allowlist.waitFor({ timeout: 10_000 });
  await expect(window.getByTestId("claim-owner")).toHaveCount(0);
  await expect(allowlist.locator("li", { hasText: "Desk Owner" })).toContainText("owner");
  expect(await loginStatus("desk owner", OWNER_PASSWORD)).toBe(200);

  // Adding the owner's own name again is refused, not read as "replace its
  // password" — that used to report success and add nobody.
  const add = window.getByTestId("add-local-account");
  await add.locator("#new-account-username").fill("desk owner");
  await add.locator("#new-account-password").fill("an-attempted-overwrite");
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(allowlist.locator("p.text-destructive")).toContainText("already exists");
  expect(await loginStatus("desk owner", OWNER_PASSWORD)).toBe(200);
  expect(await loginStatus("desk owner", "an-attempted-overwrite")).toBe(401);

  // Add a local account.
  await add.locator("#new-account-username").fill("e2e-desk-guest");
  await add.locator("#new-account-password").fill(GUEST_PASSWORD);
  await add.getByRole("button", { name: "Add account" }).click();
  await expect(window.getByTestId("allowlist-notice")).toContainText("can now sign in");
  const row = allowlist.locator("li", { hasText: "e2e-desk-guest" });
  await expect(row).toBeVisible();
  expect(await loginStatus("e2e-desk-guest", GUEST_PASSWORD)).toBe(200);

  // Reset its password.
  await row.getByTestId("set-password").click();
  await row.locator('input[type="password"]').fill(GUEST_RESET);
  await row.getByRole("button", { name: "Save" }).click();
  await expect(window.getByTestId("allowlist-notice")).toContainText("Password set");
  expect(await loginStatus("e2e-desk-guest", GUEST_PASSWORD)).toBe(401);
  expect(await loginStatus("e2e-desk-guest", GUEST_RESET)).toBe(200);

  // A too-short password is refused and the card says so.
  await row.getByTestId("set-password").click();
  await row.locator('input[type="password"]').fill("short");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(allowlist.locator("p.text-destructive")).toContainText("12");
  expect(await loginStatus("e2e-desk-guest", GUEST_RESET)).toBe(200);

  // The owner's own password can be reset from here too — the forgotten case.
  const ownerRow = allowlist.locator("li", { hasText: "Desk Owner" });
  await ownerRow.getByTestId("set-password").click();
  await ownerRow.locator('input[type="password"]').fill("the-new-owner-password");
  await ownerRow.getByRole("button", { name: "Save" }).click();
  await expect(window.getByTestId("allowlist-notice")).toContainText("Password set");
  expect(await loginStatus("desk owner", "the-new-owner-password")).toBe(200);
  // ...and the owner cannot be removed, so it offers no Remove button.
  await expect(ownerRow.getByRole("button", { name: "Remove" })).toHaveCount(0);

  // Remove the account: two clicks.
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Confirm remove" }).click();
  await expect(allowlist.locator("li", { hasText: "e2e-desk-guest" })).toHaveCount(0);
  expect(await loginStatus("e2e-desk-guest", GUEST_RESET)).toBe(401);

  await invoke(window, "server:stop");
});
