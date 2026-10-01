/**
 * Playwright E2E — access requests and linked sign-in methods, over a real
 * daemon.
 *
 * The provider leg cannot run here: the e2e daemon has no Google/GitHub/
 * Facebook credentials, and no test could complete a real consent screen if
 * it did. So the rows only a callback produces are seeded (see
 * `seedAccessRequest` in the harness), and everything an owner or a guest
 * *does* with them is driven through the app — the channels, the HTTP routes,
 * and the Settings card. The callback itself is pinned in
 * `src/__tests__/regressions/web-linked-logins.test.ts` with a fake strategy.
 *
 * As in `web-identities.test.ts`, the load-bearing assertions are the refusals:
 * a signed-in guest gets nothing from the owner's channels, and cannot remove
 * a sign-in method that is not theirs.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  WEB_ORIGIN,
  clearSeededSignIns,
  invoke,
  seedAccessRequest,
  seedSignInLink,
  setMpcReminderDisabled,
  signIn,
} from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-link-guest";
const GUEST_PASSWORD = "a-perfectly-fine-link-guest-password";
const SEEDED = ["e2e-req-approve", "e2e-req-dismiss", "e2e-req-ui", "e2e-link-owner", "e2e-link-guest"];

interface Link {
  id: number;
  identityId: number;
  provider: string;
  subject: string;
}

interface Identity {
  id: number;
  provider: string;
  subject: string;
  isOwner: boolean;
  links: Link[];
}

interface AccessRequest {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}

async function identities(request: APIRequestContext): Promise<Identity[]> {
  const res = await invoke<{ identities?: Identity[]; error?: string }>(
    request,
    "server:listIdentities"
  );
  expect(res.error).toBeUndefined();
  return res.identities ?? [];
}

async function requests(request: APIRequestContext): Promise<AccessRequest[]> {
  const res = await invoke<{ requests?: AccessRequest[]; error?: string }>(
    request,
    "server:listAccessRequests"
  );
  expect(res.error).toBeUndefined();
  return res.requests ?? [];
}

/** Removes everything this spec may have added, so it re-runs cleanly against
 *  the shared daemon. */
async function cleanUp(owner: APIRequestContext): Promise<void> {
  clearSeededSignIns(SEEDED);
  for (const i of await identities(owner)) {
    if (i.subject === GUEST_USERNAME || SEEDED.includes(i.subject)) {
      await invoke(owner, "server:revokeIdentity", i.id);
    }
  }
}

async function guestContext(owner: APIRequestContext): Promise<APIRequestContext> {
  await invoke(owner, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    password: GUEST_PASSWORD,
  });
  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  return guest;
}

test.beforeEach(async ({ request }) => {
  await signIn(request);
  await cleanUp(request);
});

test.afterAll(async () => {
  const owner = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  await signIn(owner);
  await cleanUp(owner);
  await owner.dispose();
});

test("the owner approves one refused sign-in and dismisses another", async ({ request }) => {
  const approveId = seedAccessRequest("google", "e2e-req-approve", "friend@example.com", "Friend");
  const dismissId = seedAccessRequest("github", "e2e-req-dismiss", null, "Stranger");

  const listed = await requests(request);
  expect(listed.map((r) => r.id)).toEqual(expect.arrayContaining([approveId, dismissId]));

  const approved = await invoke<{ ok?: boolean; identity?: Identity; error?: string }>(
    request,
    "server:approveAccessRequest",
    approveId
  );
  expect(approved.error).toBeUndefined();
  // An approval admits an ordinary account. Ownership is claimed once.
  expect(approved.identity?.isOwner).toBe(false);
  expect(approved.identity?.subject).toBe("e2e-req-approve");

  expect((await invoke<{ error?: string }>(request, "server:dismissAccessRequest", dismissId)).error)
    .toBeUndefined();

  const after = await requests(request);
  expect(after.some((r) => r.id === approveId || r.id === dismissId)).toBe(false);
  const list = await identities(request);
  expect(list.some((i) => i.subject === "e2e-req-approve")).toBe(true);
  // Dismissing admits nobody.
  expect(list.some((i) => i.subject === "e2e-req-dismiss")).toBe(false);
});

test("a signed-in guest is refused by every access-request and link channel", async ({
  request,
}) => {
  const reqId = seedAccessRequest("google", "e2e-req-approve", null, null);
  const ownerId = (await identities(request)).find((i) => i.isOwner)!.id;
  const linkId = seedSignInLink(ownerId, "google", "e2e-link-owner");

  const guest = await guestContext(request);
  // The control: an ordinary channel works, so a refusal below is the gate.
  expect((await invoke<{ error?: string }>(guest, "library:getStats")).error).toBeUndefined();

  for (const [channel, arg] of [
    ["server:listAccessRequests", undefined],
    ["server:approveAccessRequest", reqId],
    ["server:dismissAccessRequest", reqId],
    ["server:removeLink", linkId],
  ] as const) {
    const res = await invoke<{ error?: string }>(
      guest,
      channel,
      ...(arg === undefined ? [] : [arg])
    );
    expect(res.error, `${channel} must refuse a non-owner`).toContain("owner");
  }
  // The same, over the HTTP routes.
  expect((await guest.get("/api/auth/access-requests")).status()).toBe(403);
  expect((await guest.post(`/api/auth/access-requests/${reqId}/approve`)).status()).toBe(403);

  // Nothing took effect.
  expect((await requests(request)).some((r) => r.id === reqId)).toBe(true);
  expect((await identities(request)).some((i) => i.subject === "e2e-req-approve")).toBe(false);
  const owner = (await identities(request)).find((i) => i.isOwner)!;
  expect(owner.links.some((l) => l.id === linkId)).toBe(true);

  await guest.dispose();
});

test("a guest removes their own sign-in method and not the owner's", async ({ request }) => {
  const guest = await guestContext(request);
  const list = await identities(request);
  const ownerId = list.find((i) => i.isOwner)!.id;
  const guestId = list.find((i) => i.subject === GUEST_USERNAME)!.id;
  const ownerLink = seedSignInLink(ownerId, "google", "e2e-link-owner");
  const guestLink = seedSignInLink(guestId, "github", "e2e-link-guest");

  // The owner sees every way in, under the identity it signs in as.
  const seen = await identities(request);
  expect(seen.find((i) => i.id === ownerId)!.links.map((l) => l.id)).toContain(ownerLink);
  expect(seen.find((i) => i.id === guestId)!.links.map((l) => l.id)).toEqual([guestLink]);

  // A guest lists only their own.
  const mine = (await (await guest.get("/api/auth/links")).json()) as { links: Link[] };
  expect(mine.links.map((l) => l.id)).toEqual([guestLink]);

  expect((await guest.delete(`/api/auth/links/${ownerLink}`)).status()).toBe(403);
  expect((await guest.delete(`/api/auth/links/${guestLink}`)).ok()).toBe(true);

  const after = await identities(request);
  expect(after.find((i) => i.id === ownerId)!.links.map((l) => l.id)).toContain(ownerLink);
  expect(after.find((i) => i.id === guestId)!.links).toEqual([]);
  // Removing a link leaves the account signed in.
  expect((await invoke<{ error?: string }>(guest, "library:getStats")).error).toBeUndefined();

  // And the owner can remove anyone's.
  expect((await invoke<{ error?: string }>(request, "server:removeLink", ownerLink)).error)
    .toBeUndefined();

  await guest.dispose();
});

test("linking refuses a provider this server has not configured", async ({ request }) => {
  // The e2e daemon has no provider, so this is the whole of what the start
  // route can show here: it will not mark a session for a provider that has
  // no strategy behind it.
  expect((await request.post("/api/auth/link/google")).status()).toBe(404);
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  expect((await anon.post("/api/auth/link/google")).status()).toBe(401);
  await anon.dispose();
});

test("Settings shows who is waiting, and approving takes them off the list", async ({
  page,
  request,
}) => {
  const previous = await setMpcReminderDisabled(request, true);
  try {
    seedAccessRequest("google", "e2e-req-ui", "ui@example.com", "UI Requester");
    await signIn(page.request);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();

    // Web mode, so the self-service card is there too.
    await expect(page.getByTestId("sign-in-methods")).toBeVisible();

    const allowlist = page.getByTestId("sign-in-allowlist");
    await allowlist.scrollIntoViewIfNeeded();
    const row = allowlist.getByTestId("access-request").filter({ hasText: "UI Requester" });
    await expect(row).toBeVisible();
    // The provider and email are always beside the self-chosen name.
    await expect(row).toContainText("Google");
    await expect(row).toContainText("ui@example.com");

    await row.getByRole("button", { name: "Approve" }).click();
    await expect(row).toHaveCount(0);
    await expect(allowlist).toContainText("UI Requester");
    expect((await identities(request)).some((i) => i.subject === "e2e-req-ui")).toBe(true);
  } finally {
    await setMpcReminderDisabled(request, previous);
  }
});
