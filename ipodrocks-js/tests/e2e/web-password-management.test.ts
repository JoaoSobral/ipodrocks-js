/**
 * Playwright E2E — changing and resetting web server passwords over a real
 * daemon with real cookies.
 *
 * Two routes into one function (`resetLocalPassword()`):
 *
 * - `POST /api/auth/local/password` — any signed-in local account changes its
 *   *own* password, proving the current one. It is a password-guessing oracle
 *   for whoever holds the session, so it shares the login form's per-account
 *   rate-limit bucket; the load-bearing assertion is that a locked bucket
 *   refuses even the right password.
 * - `server:setPassword` — the owner resets anybody's. A guest is refused, with
 *   an ordinary channel as the control.
 *
 * Both sign the account out of every *other* browser and keep the caller's.
 * `server:claimOwner` is pinned here too, from the side that must be refused:
 * a web caller.
 *
 * The owner recovery token needs its own daemon (an env var at boot) and lives
 * in `web-owner-reset.test.ts`.
 *
 * The spec puts the server back the way it found it: the `web` project runs
 * every spec against one long-lived daemon.
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST = "e2e-pw-guest";
const GUEST_PASSWORD = "the-guest-original-password";
const GUEST_NEW = "the-guest-changed-password";
const GUEST_RESET = "the-owner-chose-this-password";

interface Identity {
  id: number;
  subject: string;
  isOwner: boolean;
}

async function identities(owner: APIRequestContext): Promise<Identity[]> {
  const res = await invoke<{ identities: Identity[] }>(owner, "server:listIdentities");
  return res.identities;
}

async function removeAccount(owner: APIRequestContext, subject: string): Promise<void> {
  const found = (await identities(owner)).find((i) => i.subject === subject);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

async function addAccount(owner: APIRequestContext, subject: string, password: string) {
  const res = await invoke<{ error?: string }>(owner, "server:allowIdentity", {
    provider: "local",
    subject,
    password,
  });
  expect(res.error).toBeUndefined();
}

async function login(username: string, password: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const res = await ctx.post("/api/auth/local/login", { data: { username, password } });
  expect(res.ok(), `${username} signs in`).toBe(true);
  return ctx;
}

async function loginStatus(username: string, password: string): Promise<number> {
  const ctx = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const res = await ctx.post("/api/auth/local/login", { data: { username, password } });
  await ctx.dispose();
  return res.status();
}

/** Whether a context's session is still alive, judged by an ordinary channel. */
async function stillSignedIn(ctx: APIRequestContext): Promise<boolean> {
  const res = await ctx.post("/api/invoke/library:getStats", { data: { args: [] } });
  return res.status() !== 401;
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  await removeAccount(request, GUEST);
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  await removeAccount(request, GUEST);
});

test("a guest changes their own password and only their other browsers are signed out", async ({
  request,
}) => {
  await signIn(request);
  await addAccount(request, GUEST, GUEST_PASSWORD);

  const here = await login(GUEST, GUEST_PASSWORD);
  const laptop = await login(GUEST, GUEST_PASSWORD);

  const wrong = await here.post("/api/auth/local/password", {
    data: { currentPassword: "not-the-current-one", newPassword: GUEST_NEW },
  });
  expect(wrong.status()).toBe(403);

  const weak = await here.post("/api/auth/local/password", {
    data: { currentPassword: GUEST_PASSWORD, newPassword: "short" },
  });
  expect(weak.status()).toBe(400);

  const changed = await here.post("/api/auth/local/password", {
    data: { currentPassword: GUEST_PASSWORD, newPassword: GUEST_NEW },
  });
  expect(changed.ok()).toBe(true);
  expect(((await changed.json()) as { signedOut: number }).signedOut).toBe(1);

  expect(await stillSignedIn(here), "the tab that changed it stays signed in").toBe(true);
  expect(await stillSignedIn(laptop), "the other browser is signed out").toBe(false);

  expect(await loginStatus(GUEST, GUEST_PASSWORD)).toBe(401);
  expect(await loginStatus(GUEST, GUEST_NEW)).toBe(200);

  await here.dispose();
  await laptop.dispose();
});

test("a signed-out caller cannot change a password", async () => {
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const res = await anon.post("/api/auth/local/password", {
    data: { currentPassword: GUEST_NEW, newPassword: "something-long-enough" },
  });
  expect(res.status()).toBe(401);
  await anon.dispose();
});

test("guessing the current password is rate-limited like the login form", async ({
  request,
}) => {
  // A fresh account per run: the lockout outlives the spec by fifteen minutes,
  // and a re-run must not inherit it.
  const subject = `e2e-pw-lock-${Date.now()}`;
  const password = "the-lockout-account-password";
  await signIn(request);
  await addAccount(request, subject, password);
  const session = await login(subject, password);

  let locked = false;
  for (let i = 0; i < 12 && !locked; i++) {
    const res = await session.post("/api/auth/local/password", {
      data: { currentPassword: `wrong-guess-${i}`, newPassword: "a-new-long-password" },
    });
    if (res.status() === 429) locked = true;
    else expect(res.status()).toBe(403);
  }
  expect(locked, "the per-account ceiling applies").toBe(true);

  // The point of a lockout: once it is on, being right does not help.
  const right = await session.post("/api/auth/local/password", {
    data: { currentPassword: password, newPassword: "a-new-long-password" },
  });
  expect(right.status()).toBe(429);
  // And it is the *same* bucket as the login form, not a second ten tries.
  expect(await loginStatus(subject, password)).toBe(429);

  await session.dispose();
  // A successful owner login clears the shared per-address bucket again.
  await signIn(request);
  await removeAccount(request, subject);
});

test("the owner resets a guest's password; the guest cannot reset anyone's", async ({
  request,
}) => {
  await signIn(request);
  const guest = await login(GUEST, GUEST_NEW);
  const guestId = (await identities(request)).find((i) => i.subject === GUEST)!.id;
  const ownerId = (await identities(request)).find((i) => i.isOwner)!.id;

  // The control: an ordinary channel works, so the refusals are the gate.
  expect(await stillSignedIn(guest)).toBe(true);
  for (const target of [ownerId, guestId]) {
    const res = await invoke<{ error?: string }>(guest, "server:setPassword", {
      identityId: target,
      password: "a-guest-chosen-password",
    });
    expect(res.error, "server:setPassword is owner-only").toContain("owner");
  }

  const reset = await invoke<{ ok?: boolean; signedOut?: number; error?: string }>(
    request,
    "server:setPassword",
    { identityId: guestId, password: GUEST_RESET }
  );
  expect(reset.error).toBeUndefined();
  // At least this guest's session; the earlier logins in this spec left
  // their rows behind too, since disposing a client does not sign it out.
  expect(reset.signedOut).toBeGreaterThanOrEqual(1);
  expect(await stillSignedIn(guest), "the guest's session is gone").toBe(false);
  expect(await loginStatus(GUEST, GUEST_NEW)).toBe(401);
  expect(await loginStatus(GUEST, GUEST_RESET)).toBe(200);
  // The owner's own session was not touched.
  expect(await stillSignedIn(request)).toBe(true);

  await guest.dispose();
});

test("a web caller cannot create an owner through the desktop's claim channel", async ({
  request,
}) => {
  await signIn(request);
  const before = (await identities(request)).filter((i) => i.isOwner);
  const guest = await login(GUEST, GUEST_RESET);
  for (const ctx of [guest, request]) {
    const res = await invoke<{ error?: string }>(ctx, "server:claimOwner", {
      username: "e2e-second-owner",
      password: "another-long-password",
    });
    expect(res.error).toBeTruthy();
  }
  const after = await identities(request);
  expect(after.filter((i) => i.isOwner)).toEqual(before);
  expect(after.find((i) => i.subject === "e2e-second-owner")).toBeUndefined();
  await guest.dispose();
});

test("the owner recovery route is closed on a daemon started without the flag", async () => {
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const status = (await (await anon.get("/api/auth/status")).json()) as {
    ownerResetAvailable: boolean;
  };
  expect(status.ownerResetAvailable).toBe(false);
  const res = await anon.post("/api/auth/local/reset-owner", {
    data: { token: "anything", newPassword: "a-long-enough-password" },
  });
  expect(res.status()).toBe(403);
  await anon.dispose();
});
