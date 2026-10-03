/**
 * @vitest-environment node
 *
 * Regression — linked sign-in methods and access requests.
 *
 * Admitting a Google account used to mean typing its numeric provider user id
 * into the allowlist, which nobody knows. Two ways round that, and both sit on
 * the gate, so the properties below are what keeps them from being a way
 * *past* it:
 *
 * - **A link is a login method for an existing identity.** Signing in through
 *   one must land in that identity — same id, same owner flag, same data scope
 *   — and it can only be created by a session already signed in as it.
 * - **An access request admits nobody.** It is a note for the owner; approval
 *   creates an ordinary non-owner identity, and anyone with a Google account
 *   can write one, so the table is bounded.
 *
 * The real provider leg (and its `state` nonce) cannot run here; a fake
 * strategy stands in for "the provider says this is account X", the same way
 * `oauth-callback-lockout.test.ts` stands in for a failure.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import express from "express";
import session from "express-session";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let db: typeof import("../../server/db");
let ids: typeof import("../../server/auth/identities");
let server: http.Server;
let base: string;

/** What the fake provider says the account is, per provider. */
const profiles: Record<string, { subject: string; email: string | null } | null> = {
  google: null,
  github: null,
};

const OWNER = { username: "owner", password: "owner-password-long-enough" };
const GUEST = { username: "guest", password: "guest-password-long-enough" };

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-linked-logins-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  ids = await import("../../server/auth/identities");

  const { passport } = await import("../../server/auth/passport-setup");
  const { createAuthRouter } = await import("../../server/auth/routes");

  for (const provider of ["google", "github"] as const) {
    profiles[provider] = null;
    passport.use(provider, {
      authenticate(this: { success: (u: unknown) => void; fail: () => void }) {
        const p = profiles[provider];
        if (!p) return this.fail();
        this.success({
          provider,
          subject: p.subject,
          email: p.email,
          displayName: `${provider} user`,
          emailVerified: p.email !== null,
        });
      },
    } as unknown as Parameters<typeof passport.use>[1]);
  }

  const app = express();
  app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      config: {} as Parameters<typeof createAuthRouter>[0]["config"],
      enabledProviders: ["google", "github"],
    })
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // An owner (claimed) and a guest, both local password accounts.
  await ids.createLocalAccount(OWNER.username, OWNER.password, { isOwner: true });
  await ids.createLocalAccount(GUEST.username, GUEST.password);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => server.close(() => r()));
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** A browser: one cookie jar, redirects not followed. */
class Client {
  private cookie = "";

  async req(method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}/api/auth${url}`, {
      method,
      redirect: "manual",
      headers: {
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return res;
  }

  async login(account: { username: string; password: string }) {
    const res = await this.req("POST", "/local/login", account);
    expect(res.status).toBe(200);
  }

  async status(): Promise<{
    authenticated: boolean;
    user: { id: number; isOwner: boolean } | null;
  }> {
    return (await (await this.req("GET", "/status")).json()) as never;
  }

  /** Returns the callback's redirect target. */
  async callback(provider: string): Promise<string> {
    const res = await this.req("GET", `/${provider}/callback`);
    expect(res.status).toBe(302);
    return res.headers.get("location") ?? "";
  }
}

function identityId(username: string): number {
  const identity = ids.findIdentity("local", username);
  if (!identity) throw new Error(`no ${username}`);
  return identity.id;
}

describe("linking a sign-in method", () => {
  it("a linked Google login signs in *as* the owner — same identity, still the owner", async () => {
    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("POST", "/link/google")).status).toBe(200);
    profiles.google = { subject: "g-owner", email: "owner@example.com" };
    expect(await owner.callback("google")).toBe("/?auth=linked");

    // The linking session was not regenerated or downgraded.
    expect((await owner.status()).user?.id).toBe(identityId(OWNER.username));

    // A brand-new browser signing in with that Google account.
    const elsewhere = new Client();
    expect(await elsewhere.callback("google")).toBe("/");
    const status = await elsewhere.status();
    expect(status.authenticated).toBe(true);
    expect(status.user?.id).toBe(identityId(OWNER.username));
    expect(status.user?.isOwner).toBe(true);

    // It is not an identity of its own: no second data scope.
    expect(ids.findIdentity("google", "g-owner")).toBeNull();
  });

  it("a callback with no link pending is an ordinary login, and is refused", async () => {
    const owner = new Client();
    await owner.login(OWNER);
    profiles.google = { subject: "g-stranger", email: null };
    expect(await owner.callback("google")).toBe("/?auth=not_allowed");
    expect(ids.findLink("google", "g-stranger")).toBeNull();
  });

  it("does not link once the pending link has expired", async () => {
    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("POST", "/link/google")).status).toBe(200);
    const { PENDING_LINK_TTL_MS } = await import("../../server/auth/routes");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + PENDING_LINK_TTL_MS + 1);
    profiles.google = { subject: "g-late", email: null };
    expect(await owner.callback("google")).toBe("/?auth=not_allowed");
    expect(ids.findLink("google", "g-late")).toBeNull();
  });

  it("does not link through a different provider than the one started", async () => {
    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("POST", "/link/github")).status).toBe(200);
    profiles.google = { subject: "g-wrong-provider", email: null };
    expect(await owner.callback("google")).toBe("/?auth=not_allowed");
    expect(ids.findLink("google", "g-wrong-provider")).toBeNull();
  });

  it("refuses to start a link without a session, or for a provider that is not enabled", async () => {
    const anon = new Client();
    expect((await anon.req("POST", "/link/google")).status).toBe(401);
    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("POST", "/link/facebook")).status).toBe(404);
  });

  it("refuses an account that already signs in to this server", async () => {
    // The guest's own Google identity, admitted separately.
    ids.allowProviderIdentity({ provider: "google", subject: "g-guest" });
    const owner = new Client();
    await owner.login(OWNER);
    await owner.req("POST", "/link/google");
    profiles.google = { subject: "g-guest", email: null };
    expect(await owner.callback("google")).toBe("/?auth=link_failed&reason=already_used");
    expect(ids.findLink("google", "g-guest")).toBeNull();
  });

  it("a guest links to the guest — never to anyone else", async () => {
    const guest = new Client();
    await guest.login(GUEST);
    await guest.req("POST", "/link/google");
    profiles.google = { subject: "g-guest-2", email: null };
    expect(await guest.callback("google")).toBe("/?auth=linked");
    expect(ids.findLink("google", "g-guest-2")?.identityId).toBe(identityId(GUEST.username));

    const elsewhere = new Client();
    await elsewhere.callback("google");
    const status = await elsewhere.status();
    expect(status.user?.id).toBe(identityId(GUEST.username));
    expect(status.user?.isOwner).toBe(false);
  });
});

describe("removing a linked sign-in method", () => {
  it("a guest removes their own link, not the owner's; the owner removes anyone's", async () => {
    const ownerLink = ids.addLink({
      identityId: identityId(OWNER.username),
      provider: "google",
      subject: "g-o",
    });
    const guestLink = ids.addLink({
      identityId: identityId(GUEST.username),
      provider: "github",
      subject: "gh-g",
    });
    if (!("link" in ownerLink) || !("link" in guestLink)) throw new Error("setup");

    const guest = new Client();
    await guest.login(GUEST);
    const mine = (await (await guest.req("GET", "/links")).json()) as {
      links: { id: number }[];
    };
    expect(mine.links.map((l) => l.id)).toEqual([guestLink.link.id]);
    expect((await guest.req("DELETE", `/links/${ownerLink.link.id}`)).status).toBe(403);
    expect(ids.findLinkById(ownerLink.link.id)).not.toBeNull();

    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("DELETE", `/links/${guestLink.link.id}`)).status).toBe(200);
    expect(ids.findLinkById(guestLink.link.id)).toBeNull();
  });

  it("removing an identity removes its links", () => {
    const guestId = identityId(GUEST.username);
    ids.addLink({ identityId: guestId, provider: "google", subject: "g-cascade" });
    expect(ids.removeIdentity(guestId)).toEqual({ ok: true });
    expect(ids.findLink("google", "g-cascade")).toBeNull();
  });

  it("an account that is a link cannot also be admitted as an identity of its own", () => {
    ids.addLink({ identityId: identityId(GUEST.username), provider: "google", subject: "g-dup" });
    const outcome = ids.allowProviderIdentity({ provider: "google", subject: "g-dup" });
    expect("error" in outcome).toBe(true);
    expect(ids.findIdentity("google", "g-dup")).toBeNull();
  });
});

describe("access requests", () => {
  it("a refused provider login is recorded, and a repeat bumps the same row", () => {
    for (let i = 0; i < 2; i++) {
      const refused = ids.authorizeIdentity({
        provider: "google",
        subject: "g-knock",
        email: "knock@example.com",
        emailVerified: true,
        displayName: "Knock",
      });
      expect("error" in refused).toBe(true);
    }
    const [req, ...rest] = ids.listAccessRequests();
    expect(rest).toHaveLength(0);
    expect(req).toMatchObject({
      provider: "google",
      subject: "g-knock",
      email: "knock@example.com",
      emailVerified: true,
      attempts: 2,
    });
  });

  it("records nothing for a local login or for a first-run claim", () => {
    ids.authorizeIdentity({ provider: "local", subject: "nobody" });
    expect(ids.listAccessRequests()).toHaveLength(0);

    // An empty allowlist: a refusal there is a claim without a token.
    for (const i of ids.listIdentities()) {
      db.getServerDb().prepare("DELETE FROM server_identities WHERE id = ?").run(i.id);
    }
    ids.authorizeIdentity({ provider: "google", subject: "g-claimer" });
    expect(ids.listAccessRequests()).toHaveLength(0);
  });

  it("keeps only the newest 50, and forgets one not seen for 30 days", () => {
    const t0 = 1_800_000_000_000;
    ids.recordAccessRequest(
      { provider: "google", subject: "old", email: null, emailVerified: false, displayName: null },
      t0
    );
    const later = t0 + ids.ACCESS_REQUEST_TTL_MS + 1;
    expect(ids.listAccessRequests(later)).toHaveLength(0);

    for (let i = 0; i < ids.MAX_ACCESS_REQUESTS + 5; i++) {
      ids.recordAccessRequest(
        { provider: "github", subject: `s${i}`, email: null, emailVerified: false, displayName: null },
        later + i
      );
    }
    const kept = ids.listAccessRequests(later + 100);
    expect(kept).toHaveLength(ids.MAX_ACCESS_REQUESTS);
    expect(kept.some((r) => r.subject === "s0")).toBe(false);
    expect(kept[0].subject).toBe(`s${ids.MAX_ACCESS_REQUESTS + 4}`);
  });

  it("approving admits an ordinary, non-owner account, once", () => {
    ids.authorizeIdentity({
      provider: "google",
      subject: "g-friend",
      email: "unverified@example.com",
      emailVerified: false,
    });
    const [req] = ids.listAccessRequests();
    const approved = ids.approveAccessRequest(req.id);
    if (!("identity" in approved)) throw new Error(approved.error);
    expect(approved.identity.isOwner).toBe(false);
    // An unverified address is shown to the owner, never stored on the account.
    expect(approved.identity.email).toBeNull();
    expect(ids.listAccessRequests()).toHaveLength(0);
    expect("error" in ids.approveAccessRequest(req.id)).toBe(true);

    // And they can now sign in.
    expect("identity" in ids.authorizeIdentity({ provider: "google", subject: "g-friend" })).toBe(
      true
    );
  });

  it("refuses to approve an account that has since become someone's link", () => {
    ids.authorizeIdentity({ provider: "google", subject: "g-race" });
    const [req] = ids.listAccessRequests();
    // `addLink` answers the request itself, so put it back to model the race.
    ids.addLink({ identityId: identityId(GUEST.username), provider: "google", subject: "g-race" });
    ids.recordAccessRequest({
      provider: "google",
      subject: "g-race",
      email: null,
      emailVerified: false,
      displayName: null,
    });
    const again = ids.listAccessRequests()[0];
    expect(again.subject).toBe(req.subject);
    expect("error" in ids.approveAccessRequest(again.id)).toBe(true);
    expect(ids.findIdentity("google", "g-race")).toBeNull();
  });

  it("the access-request routes are the owner's alone", async () => {
    ids.authorizeIdentity({ provider: "google", subject: "g-wait" });
    const [req] = ids.listAccessRequests();

    const guest = new Client();
    await guest.login(GUEST);
    expect((await guest.req("GET", "/access-requests")).status).toBe(403);
    expect((await guest.req("POST", `/access-requests/${req.id}/approve`)).status).toBe(403);
    expect((await guest.req("DELETE", `/access-requests/${req.id}`)).status).toBe(403);
    expect(ids.findIdentity("google", "g-wait")).toBeNull();

    const owner = new Client();
    await owner.login(OWNER);
    expect((await owner.req("POST", `/access-requests/${req.id}/approve`)).status).toBe(200);
    expect(ids.findIdentity("google", "g-wait")?.isOwner).toBe(false);
  });
});
