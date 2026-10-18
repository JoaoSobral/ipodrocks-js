/**
 * Playwright E2E — the "scan your library?" reminder in the web UI.
 *
 * In a browser it is a toast, never a modal, and only the server's owner gets
 * it: the library is shared, and a guest neither decides when it is rescanned
 * nor should be nagged about it. "Not now" quiets it for 10 days, server-wide.
 *
 * The daemon is shared by every web spec, so the reminder is made due by
 * backdating the stored last-scan time directly, and put back afterwards —
 * a toast left due would sit over every later spec's page.
 *
 * Run: `npm run build && npx playwright test --project=web web-scan-reminder`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { test, expect, request as playwrightRequest, type Browser } from "@playwright/test";
import { WEB_DATA_DIR, WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-scan-reminder-guest";
const GUEST_PASSWORD = "a-perfectly-fine-reminder-password";
const DAY = 24 * 60 * 60 * 1000;

let musicDir: string;
let folderId: number;

interface Identity {
  id: number;
  subject: string;
}

function setLastScan(at: number): void {
  const db = new Database(path.join(WEB_DATA_DIR, "ipodrock.db"));
  try {
    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('last_library_scan_at', ?, CURRENT_TIMESTAMP)"
    ).run(new Date(at).toISOString());
  } finally {
    db.close();
  }
}

async function removeGuest(owner: import("@playwright/test").APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

async function openAs(browser: Browser, username: string, password: string) {
  const context = await browser.newContext({ baseURL: WEB_ORIGIN });
  const login = await context.request.post("/api/auth/local/login", { data: { username, password } });
  expect(login.ok()).toBe(true);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  musicDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-scan-reminder-"));
  folderId = await invoke<number>(request, "library:addFolder", {
    name: "ScanReminderLib",
    path: musicDir,
    contentType: "music",
  });
  expect(typeof folderId).toBe("number");
  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Reminder Guest",
    password: GUEST_PASSWORD,
  });
  setLastScan(Date.now() - 11 * DAY);
});

test.afterAll(async () => {
  setLastScan(Date.now());
  const owner = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  await signIn(owner);
  try {
    await removeGuest(owner);
    if (folderId) await invoke(owner, "library:removeFolder", folderId);
  } finally {
    await owner.dispose();
  }
  fs.rmSync(musicDir, { recursive: true, force: true });
});

test("a guest is never asked", async ({ browser }) => {
  const { context, page } = await openAs(browser, GUEST_USERNAME, GUEST_PASSWORD);
  try {
    // Give the startup check time to have answered.
    await page.waitForTimeout(1500);
    await expect(page.getByText("You haven't scanned your library since")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("the owner gets a toast, and 'Not now' quiets it for 10 days", async ({ browser, request }) => {
  const { context, page } = await openAs(browser, "e2e-owner", "correct-horse-battery-staple");
  try {
    const toast = page.locator("[data-sonner-toast]", { hasText: "You haven't scanned your library since" });
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText("Do you wish to scan it now?");
    // A toast, not a dialog in front of the page.
    await expect(page.getByTestId("scan-reminder")).toHaveCount(0);
    await toast.getByRole("button", { name: "Not now" }).click();

    await signIn(request);
    await expect
      .poll(async () => (await invoke<{ due: boolean }>(request, "library:getScanReminder")).due)
      .toBe(false);

    await page.reload();
    await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await expect(page.getByText("You haven't scanned your library since")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
