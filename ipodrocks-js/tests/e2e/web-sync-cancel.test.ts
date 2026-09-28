/**
 * Playwright E2E — `sync:cancel` is scoped to the caller, like `sync:start`.
 *
 * The handler aborted whatever device id it was handed — or, with no argument,
 * every sync on the server — with none of the locality and ownership checks
 * `sync:start` applies. Over `/api/invoke` any allowlisted account could stop
 * another's sync mid-`delete-all` and leave their player empty; the shipped
 * renderer's bare "Cancel" did the same thing by accident.
 *
 * Timing a cancel against a running sync is racy over a real daemon, so this
 * pins the refusals (which are decided before anything is looked up) and the
 * control that the owner's own cancel is not refused. The "a running sync
 * survives someone else's cancel" half is pinned in
 * `src/__tests__/regressions/sync-cancel-scope.test.ts`.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const INTRUDER_USERNAME = "e2e-sync-cancel-intruder";
const INTRUDER_PASSWORD = "an-entirely-valid-cancel-password";

let deviceId: number;

test.beforeAll(async ({ request }) => {
  await signIn(request);
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Cancel Target ${Date.now()}`,
    transport: "web",
    modelId: null,
  });
  deviceId = device.id;
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: INTRUDER_USERNAME,
    displayName: "E2E Sync Cancel Intruder",
    password: INTRUDER_PASSWORD,
  });
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  try {
    const res = await invoke<{ identities?: { id: number; subject: string }[] }>(
      request,
      "server:listIdentities"
    );
    const id = res.identities?.find((i) => i.subject === INTRUDER_USERNAME)?.id;
    if (id) await invoke(request, "server:revokeIdentity", id);
  } catch {
    /* ditto */
  }
});

test("another account cannot cancel a sync on a device it does not own", async ({
  request,
}) => {
  const intruder = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  try {
    const login = await intruder.post("/api/auth/local/login", {
      data: { username: INTRUDER_USERNAME, password: INTRUDER_PASSWORD },
    });
    expect(login.ok()).toBe(true);

    const named = await invoke<{ error?: string; cancelled?: boolean }>(
      intruder,
      "sync:cancel",
      deviceId
    );
    expect(named.error ?? "").toMatch(/different account/i);

    // The bare form cancels only the caller's own syncs, of which it has none.
    const bare = await invoke<{ error?: string; cancelled?: boolean }>(
      intruder,
      "sync:cancel"
    );
    expect(bare.error).toBeUndefined();
    expect(bare.cancelled).toBe(false);
  } finally {
    await intruder.dispose();
  }

  // Control: the owner's cancel of the same device is not refused.
  await signIn(request);
  const own = await invoke<{ error?: string; cancelled?: boolean }>(
    request,
    "sync:cancel",
    deviceId
  );
  expect(own.error).toBeUndefined();
  expect(own.cancelled).toBe(false);
});
