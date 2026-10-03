/**
 * Playwright E2E — what the web client does when its connection misbehaves.
 *
 * Every failure mode here used to surface as something else: a panel stuck on
 * a spinner, a generic "HTTP 524", progress that silently stopped. Now the
 * transport reconnects on its own (immediately when the network comes back),
 * says what it is doing in one banner, replays what it missed — or says
 * `resync` when it cannot — and notices when the server it reconnected to is
 * running a different build.
 *
 * The transport is reached through `window.__ipodrocksTransport`, the same way
 * the device specs reach the device client: to make the network misbehave on
 * cue, not to take a different code path.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, type Page } from "@playwright/test";
import { setMpcReminderDisabled, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

let mpcReminderWasDisabled = false;

test.beforeAll(async ({ request }) => {
  await signIn(request);
  mpcReminderWasDisabled = await setMpcReminderDisabled(request, true);
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  await setMpcReminderDisabled(request, mpcReminderWasDisabled);
});

test.beforeEach(async ({ page }) => {
  await signIn(page.request);
  await page.goto("/");
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksTransport?: unknown }).__ipodrocksTransport
  );
});

type TransportHandle = {
  simulateDrop(): void;
  onResync(cb: () => void): () => void;
  getConnectionState(): { status: string; updateAvailable: boolean };
};

/** Runs `fn` in the page against the live transport. Passed as source, not
 *  through `new Function` in the page, which the app's CSP would refuse. */
function transport(page: Page, fn: (t: TransportHandle & Record<string, unknown>) => unknown) {
  return page.evaluate(`(${fn.toString()})(window.__ipodrocksTransport)`);
}

test("the banner says the connection is gone, and clears when it is back", async ({
  page,
  context,
}) => {
  const banner = page.getByTestId("connection-banner");
  await expect(banner).toHaveCount(0);

  await context.setOffline(true);
  await transport(page, (t) => t.simulateDrop());
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-status", /offline|reconnecting/);

  // The `online` event reconnects at once instead of waiting out the backoff.
  await context.setOffline(false);
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(() => transport(page, (t) => t.getConnectionState().status))
    .toBe("online");
});

test("a call made while offline waits for the network instead of failing", async ({
  page,
  context,
}) => {
  await context.setOffline(true);
  await transport(page, (t) => t.simulateDrop());
  const call = page.evaluate(() =>
    (
      window as unknown as { api: { invoke(c: string): Promise<{ version?: string }> } }
    ).api.invoke("app:getVersion")
  );
  await page.waitForTimeout(1500);
  await context.setOffline(false);
  const answer = await call;
  expect(answer.version).toBeTruthy();
});

test("a reconnect that cannot be replayed asks the page to re-read its state", async ({
  page,
}) => {
  await transport(page, (t) => {
    (window as unknown as { __resynced: number }).__resynced = 0;
    t.onResync(() => {
      (window as unknown as { __resynced: number }).__resynced++;
    });
    // As though the last frames came from a server process that has since
    // restarted: its sequence numbers mean nothing to this one.
    t.epoch = "a-previous-server-process";
    t.simulateDrop();
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __resynced: number }).__resynced))
    .toBe(1);
});

test("a reconnect to a server running a different build offers a reload", async ({
  page,
}) => {
  await transport(page, (t) => {
    // The bundle this tab loaded, as far as it knows, is not the one the
    // server now serves — what an update under an open tab looks like.
    t.buildId = "an-older-build";
    t.simulateDrop();
  });
  const banner = page.getByTestId("connection-banner");
  await expect(banner).toContainText("updated", { timeout: 10_000 });
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
});

test("an expired session says so once, instead of failing every panel", async ({
  page,
}) => {
  await page.request.post("/api/auth/logout");
  await page
    .evaluate(() =>
      (window as unknown as { api: { invoke(c: string): Promise<unknown> } }).api.invoke(
        "app:getVersion"
      )
    )
    .catch(() => {});
  const banner = page.getByTestId("connection-banner");
  await expect(banner).toHaveAttribute("data-status", "signed-out");
  await expect(banner.getByRole("button", { name: "Sign in again" })).toBeVisible();
});
