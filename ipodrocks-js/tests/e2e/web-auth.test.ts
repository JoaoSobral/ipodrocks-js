/**
 * Playwright E2E — the web server refuses everything until it is signed in to,
 * and admission is a decision the allowlist makes, not the login.
 *
 * The three properties this pins, in the order they matter:
 *
 * 1. **Every route is closed** — `/api/invoke`, `/api/media` and the WebSocket
 *    upgrade — to an unauthenticated caller. A single route left open is the
 *    whole library.
 * 2. **The owner claim is one-shot.** The first identity binds against the
 *    token printed to the server log; a second attempt with the same token is
 *    refused, so a leaked token cannot be replayed to add an account later.
 * 3. **Rate limiting has teeth.** Repeated bad passwords get a 429 with a
 *    `Retry-After`, and the lockout survives because it is in SQLite rather
 *    than in a variable a restart would clear.
 *
 * The OAuth half of the allowlist — "a valid Google login is still refused" —
 * cannot be driven here without a live provider. It is pinned in
 * `src/__tests__/regressions/web-identity-allowlist.test.ts` against
 * `authorizeIdentity()`, which is the only thing either path consults.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import {
  OWNER_PASSWORD,
  OWNER_USERNAME,
  WEB_ORIGIN,
  invoke,
  ownerExists,
  readClaimToken,
  signIn,
} from "./web-harness";

test.describe.configure({ mode: "serial" });

test("unauthenticated requests are refused on every route", async () => {
  // A context of its own: the shared one may already hold a session cookie
  // from an earlier spec in this project.
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });

  const invokeRes = await anon.post("/api/invoke/library:getStats", {
    data: { args: [] },
  });
  expect(invokeRes.status()).toBe(401);

  // A forged token must not even get as far as being parsed.
  const mediaRes = await anon.get("/api/media/not-a-real-token");
  expect(mediaRes.status()).toBe(401);

  // The app shell itself is public — it has to be, it is the login page — but
  // it must not leak the claim token into the HTML.
  const shell = await anon.get("/");
  expect(shell.status()).toBe(200);
  const token = readClaimToken();
  if (token) expect(await shell.text()).not.toContain(token);

  await anon.dispose();
});

test("the WebSocket upgrade is refused without a session", async ({ page }) => {
  const outcome = await page.evaluate(
    (origin) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/events`);
        ws.onopen = () => resolve("open");
        ws.onerror = () => resolve("error");
        ws.onclose = () => resolve("closed");
        setTimeout(() => resolve("timeout"), 5000);
      }),
    WEB_ORIGIN
  );
  // The server answers the upgrade with 401 before the handshake completes, so
  // the browser reports it as an error/close rather than an open socket.
  expect(outcome).not.toBe("open");
});

test("the owner claim is one-shot and the token cannot be replayed", async () => {
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const claimToken = readClaimToken();

  if (!ownerExists()) {
    expect(claimToken).not.toBeNull();

    // A wrong token is refused even while the server is genuinely unclaimed.
    const wrong = await anon.post("/api/auth/local/claim", {
      data: {
        username: OWNER_USERNAME,
        password: OWNER_PASSWORD,
        claimToken: "not-the-token",
      },
    });
    expect(wrong.status()).toBe(403);

    const claimed = await anon.post("/api/auth/local/claim", {
      data: { username: OWNER_USERNAME, password: OWNER_PASSWORD, claimToken },
    });
    expect(claimed.ok()).toBe(true);
  }

  expect(ownerExists()).toBe(true);
  // Consumed: the server no longer holds it at all.
  expect(readClaimToken()).toBeNull();

  // And the route itself is closed now that an owner exists, whatever token is
  // presented.
  const replay = await anon.post("/api/auth/local/claim", {
    data: {
      username: "second-owner",
      password: "another-long-enough-password",
      claimToken: claimToken ?? "anything",
    },
  });
  expect(replay.status()).toBe(409);

  await anon.dispose();
});

test("a signed-in session reaches the API, and logging out closes it again", async ({
  request,
}) => {
  await signIn(request);

  const stats = await invoke<{ totalTracks: number }>(request, "library:getStats");
  expect(stats).toHaveProperty("totalTracks");

  const status = await request.get("/api/auth/status");
  const body = (await status.json()) as {
    authenticated: boolean;
    user: { isOwner: boolean } | null;
  };
  expect(body.authenticated).toBe(true);
  expect(body.user?.isOwner).toBe(true);

  await request.post("/api/auth/logout");
  const after = await request.post("/api/invoke/library:getStats", {
    data: { args: [] },
  });
  expect(after.status()).toBe(401);
});

test("a channel outside the allowlist is refused even when signed in", async ({
  request,
}) => {
  await signIn(request);
  // The prefix allowlist is the one gate between an authenticated client and
  // any channel that happens to be registered; it is shared with the preload
  // precisely so it cannot drift.
  const res = await request.post("/api/invoke/secret:doThing", {
    data: { args: [] },
  });
  expect(res.status()).toBe(403);
});

test("repeated bad passwords are rate limited with a Retry-After", async () => {
  const anon = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });

  // A username of its own, so locking it out cannot lock out the owner account
  // the rest of this project signs in with.
  const username = `rate-limit-probe-${Date.now()}`;
  let sawLimit = false;
  for (let i = 0; i < 14; i++) {
    const res = await anon.post("/api/auth/local/login", {
      data: { username, password: "definitely-wrong" },
    });
    if (res.status() === 429) {
      expect(Number(res.headers()["retry-after"])).toBeGreaterThan(0);
      sawLimit = true;
      break;
    }
    expect(res.status()).toBe(401);
  }
  expect(sawLimit).toBe(true);

  await anon.dispose();
});
