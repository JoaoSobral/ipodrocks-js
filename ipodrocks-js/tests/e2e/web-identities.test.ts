/**
 * Playwright E2E — managing who may sign in, over the same IPC channels the
 * Settings card and Rocksy use.
 *
 * Phase 2 exposed the allowlist over HTTP (`/api/auth/identities`) and nowhere
 * else, which left the desktop app and the assistant unable to answer "who can
 * reach my server?". Phase 6 added `server:listIdentities`,
 * `server:listSessions`, `server:allowIdentity`, `server:revokeIdentity` and
 * `server:revokeSessions` — and that is the part worth testing hard, because
 * **`/api/invoke` only checks that a caller is authenticated.**
 *
 * For every other channel that is correct: anyone on the allowlist is a full
 * user of the app by design. The allowlist is the exception, because it is the
 * gate itself. A non-owner who could call `server:revokeIdentity` could remove
 * the owner's ability to remove *them*. So the load-bearing assertion in this
 * file is not that the tools work — it is that a second, perfectly valid,
 * signed-in account gets refused by all five.
 *
 * The spec restores the server to the state it found it in (owner only, signed
 * in), because the `web` project runs every spec against one long-lived daemon.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const GUEST_USERNAME = "e2e-guest";
const GUEST_PASSWORD = "a-perfectly-fine-guest-password";

interface Identity {
  id: number;
  provider: string;
  subject: string;
  displayName: string | null;
  isOwner: boolean;
}

interface SessionInfo {
  fingerprint: string;
  identityId: number | null;
  subject: string | null;
  isOwner: boolean;
  expiresAt: number;
}

async function identities(request: APIRequestContext): Promise<Identity[]> {
  const res = await invoke<{ identities?: Identity[]; error?: string }>(
    request,
    "server:listIdentities"
  );
  expect(res.error, "owner should be able to read the allowlist").toBeUndefined();
  return res.identities ?? [];
}

/** Removes the guest if an earlier run left it behind, so the spec is
 *  re-runnable against the same daemon. */
async function removeGuest(owner: APIRequestContext): Promise<void> {
  const guest = (await identities(owner)).find((i) => i.subject === GUEST_USERNAME);
  if (guest) await invoke(owner, "server:revokeIdentity", guest.id);
}

test("the owner reads the allowlist and the live sessions", async ({ request }) => {
  await signIn(request);
  await removeGuest(request);

  const list = await identities(request);
  expect(list.length).toBeGreaterThan(0);
  const owner = list.find((i) => i.isOwner);
  expect(owner, "the claimed owner is on the list").toBeTruthy();
  expect(owner?.provider).toBe("local");

  // A password hash must never leave the server, even to its owner.
  expect(JSON.stringify(list)).not.toContain("scrypt$");

  const sessions = await invoke<{ sessions: SessionInfo[]; error?: string }>(
    request,
    "server:listSessions"
  );
  expect(sessions.error).toBeUndefined();
  const mine = sessions.sessions.find((s) => s.identityId === owner?.id);
  expect(mine, "this very session shows up in the list").toBeTruthy();
  expect(mine?.expiresAt).toBeGreaterThan(Date.now());

  // The session id is the store's key and half a credential. Nothing prints it;
  // a fingerprint that reverses to nothing is what identifies a row.
  for (const s of sessions.sessions) {
    expect(s.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  }
});

test("adding an identity is what lets it sign in", async ({ request }) => {
  await signIn(request);

  // The guest's credentials are valid before it is on the list, and refused —
  // which is the whole shape of "OAuth identifies, the allowlist admits",
  // reproduced with the one provider a test can actually drive.
  const stranger = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const before = await stranger.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(before.status()).toBe(401);
  await stranger.dispose();

  const added = await invoke<{ ok?: boolean; identity?: Identity; error?: string }>(
    request,
    "server:allowIdentity",
    {
      provider: "local",
      subject: GUEST_USERNAME,
      displayName: "E2E Guest",
      password: GUEST_PASSWORD,
    }
  );
  expect(added.error).toBeUndefined();
  expect(added.identity?.subject).toBe(GUEST_USERNAME);
  // Ownership is claimed once, with the one-time token. There is deliberately
  // no second way to grant it, including this one.
  expect(added.identity?.isOwner).toBe(false);

  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const after = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(after.ok(), "the same credentials now work").toBe(true);
  await guest.dispose();
});

test("a short password is refused rather than silently weakened", async ({
  request,
}) => {
  await signIn(request);
  const res = await invoke<{ error?: string }>(request, "server:allowIdentity", {
    provider: "local",
    subject: "e2e-too-short",
    password: "short",
  });
  expect(res.error).toBeTruthy();

  const stillAbsent = (await identities(request)).find(
    (i) => i.subject === "e2e-too-short"
  );
  expect(stillAbsent).toBeUndefined();
});

test("a signed-in non-owner cannot reshape the listener", async ({ request }) => {
  // The allowlist channels were gated from the start; these four were not,
  // and they are strictly worse. `server:setConfig` writes the bind address,
  // port, public URL, allowed origins, trusted proxies and TLS pair to prefs,
  // and `stop` + `start` is a restart that re-reads every one of them — so a
  // guest could move the server from loopback onto 0.0.0.0, clear the TLS
  // pair (which also clears the session cookie's `Secure` flag, since that is
  // derived from `config.tls`/`publicUrl`) and set `trustedProxies` so the
  // rate limiter believes any `X-Forwarded-For`. CLAUDE.md's own tier rule
  // calls this the highest one: "anything that changes what the outside world
  // can reach".
  await signIn(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Guest",
    password: GUEST_PASSWORD,
  });

  const before = await invoke<{ prefs?: Record<string, unknown>; error?: string }>(
    request,
    "server:getStatus"
  );
  expect(before.error, "the owner can read the status").toBeUndefined();

  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  expect(
    (
      await guest.post("/api/auth/local/login", {
        data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
      })
    ).ok()
  ).toBe(true);

  // The control, again: an ordinary channel works, so the refusals below are
  // the gate and not a broken login.
  expect((await invoke<{ error?: string }>(guest, "library:getStats")).error)
    .toBeUndefined();

  for (const [channel, args] of [
    ["server:getStatus", []],
    [
      "server:setConfig",
      [
        {
          host: "0.0.0.0",
          allowedOrigins: ["https://evil.example"],
          trustedProxies: ["0.0.0.0/0"],
          tls: null,
        },
      ],
    ],
    ["server:stop", []],
    ["server:start", []],
  ] as const) {
    const res = await invoke<{ error?: string }>(guest, channel, ...args);
    expect(res.error, `${channel} must refuse a non-owner`).toContain("owner");
  }

  // Nothing took effect: the prefs are byte-for-byte what they were, and the
  // server is still running — `server:stop` writes `enabled: false` before it
  // stops, so a successful one would be a permanent lock-out too.
  const after = await invoke<{ prefs?: Record<string, unknown>; running?: boolean }>(
    request,
    "server:getStatus"
  );
  expect(after.prefs).toEqual(before.prefs);
  expect(after.running).toBe(true);

  await guest.dispose();
});

test("a signed-in non-owner is refused by all five channels", async ({ request }) => {
  await signIn(request);
  // Make sure the guest exists and is genuinely signed in — this is a valid,
  // allowlisted user, not an anonymous caller. `/api/invoke` lets it through;
  // the owner gate is the only thing standing here.
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Guest",
    password: GUEST_PASSWORD,
  });

  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);

  // The control: an ordinary channel works for this session, so a refusal below
  // is the owner gate and not a broken login.
  const stats = await invoke<{ error?: string }>(guest, "library:getStats");
  expect(stats.error).toBeUndefined();

  const ownerId = (await identities(request)).find((i) => i.isOwner)?.id;
  expect(ownerId).toBeTruthy();

  for (const [channel, args] of [
    ["server:listIdentities", []],
    ["server:listSessions", []],
    ["server:allowIdentity", [{ provider: "local", subject: "e2e-intruder", password: "another-long-password" }]],
    ["server:revokeIdentity", [ownerId]],
    ["server:revokeSessions", [{ all: true }]],
  ] as const) {
    const res = await invoke<{ error?: string }>(guest, channel, ...args);
    expect(res.error, `${channel} must refuse a non-owner`).toContain("owner");
  }

  // Nothing the loop attempted took effect.
  const after = await identities(request);
  expect(after.find((i) => i.isOwner)?.id).toBe(ownerId);
  expect(after.find((i) => i.subject === "e2e-intruder")).toBeUndefined();
  // Including the `all: true` revoke — the owner's own session still works.
  expect((await invoke<{ error?: string }>(request, "server:listSessions")).error)
    .toBeUndefined();

  await guest.dispose();
});

test("revoking sessions signs a browser out without removing the account", async ({
  request,
}) => {
  await signIn(request);
  const guestIdentity = (await identities(request)).find(
    (i) => i.subject === GUEST_USERNAME
  );
  expect(guestIdentity).toBeTruthy();

  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  expect(
    (
      await guest.post("/api/auth/local/login", {
        data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
      })
    ).ok()
  ).toBe(true);

  const revoked = await invoke<{ revoked?: number; error?: string }>(
    request,
    "server:revokeSessions",
    { identityId: guestIdentity!.id }
  );
  expect(revoked.error).toBeUndefined();
  expect(revoked.revoked).toBeGreaterThan(0);

  // The cookie is dead …
  const afterRevoke = await guest.post("/api/invoke/library:getStats", {
    data: { args: [] },
  });
  expect(afterRevoke.status()).toBe(401);

  // … but the account is not, which is the difference from revokeIdentity.
  expect(
    (
      await guest.post("/api/auth/local/login", {
        data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
      })
    ).ok()
  ).toBe(true);

  await guest.dispose();
});

test("revoking an identity removes it and logs it out everywhere", async ({
  request,
}) => {
  await signIn(request);
  const guestIdentity = (await identities(request)).find(
    (i) => i.subject === GUEST_USERNAME
  );
  expect(guestIdentity).toBeTruthy();

  const guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  expect(
    (
      await guest.post("/api/auth/local/login", {
        data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
      })
    ).ok()
  ).toBe(true);

  const res = await invoke<{ ok?: boolean; sessionsRevoked?: number; error?: string }>(
    request,
    "server:revokeIdentity",
    guestIdentity!.id
  );
  expect(res.error).toBeUndefined();
  expect(res.sessionsRevoked).toBeGreaterThan(0);

  // Gone from the list, its cookie dead, and it cannot sign back in.
  expect((await identities(request)).find((i) => i.subject === GUEST_USERNAME))
    .toBeUndefined();
  expect(
    (await guest.post("/api/invoke/library:getStats", { data: { args: [] } })).status()
  ).toBe(401);
  expect(
    (
      await guest.post("/api/auth/local/login", {
        data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
      })
    ).status()
  ).toBe(401);

  // No orphaned session row is left behind claiming to be a login nobody can
  // account for.
  const sessions = await invoke<{ sessions: SessionInfo[] }>(
    request,
    "server:listSessions"
  );
  expect(sessions.sessions.some((s) => s.identityId === guestIdentity!.id)).toBe(false);

  await guest.dispose();
});

test("the owner cannot be removed", async ({ request }) => {
  await signIn(request);
  const ownerId = (await identities(request)).find((i) => i.isOwner)?.id;
  expect(ownerId).toBeTruthy();

  const res = await invoke<{ error?: string }>(
    request,
    "server:revokeIdentity",
    ownerId
  );
  // A server whose owner is gone has an allowlist nobody can edit — including
  // to put an owner back.
  expect(res.error).toBeTruthy();
  expect((await identities(request)).find((i) => i.isOwner)?.id).toBe(ownerId);
});
