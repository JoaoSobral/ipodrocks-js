/**
 * Regression — managing web server passwords, and recovering a forgotten one.
 *
 * A forgotten local password used to have two ways out: ask Rocksy (which sent
 * the new password through the model) or delete `ipodrocks-server.db` and lose
 * the whole allowlist. Now every route — Settings, Rocksy, the self-service
 * change, `cli.ts` and the log-printed owner recovery token — goes through
 * `resetLocalPassword()`, and this file pins what that one function promises:
 *
 * - a provider identity (Google, …) has no password and is refused, not
 *   quietly given a second way in;
 * - every *other* session of the account is signed out, the caller's kept;
 * - `server:setPassword` and `web_server_set_password` are owner-only;
 * - `server:claimOwner` exists only for the desktop window, and only once;
 * - the recovery token is single-use, expires, and does not survive a boot
 *   without `IPODROCKS_RESET_OWNER=1`.
 *
 * The HTTP halves are pinned over a real daemon in
 * `tests/e2e/web-password-management.test.ts`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";
import type { AiToolContext } from "../../main/assistant/tools";
import type { HandlerContext } from "../../main/host/bridge";

let dataDir: string;
let db: typeof import("../../server/db");
let identities: typeof import("../../server/auth/identities");
let reset: typeof import("../../server/auth/password-reset");
let tools: typeof import("../../main/assistant/tools");
let bridge: typeof import("../../main/host/bridge");

const OLD = "the-original-password";
const NEW = "a-brand-new-password";

function putSession(sid: string, identityId: number) {
  db.getServerDb()
    .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
    .run(sid, JSON.stringify({ identityId }), Date.now() + 60_000);
}

function sessionIds(): string[] {
  return (
    db.getServerDb().prepare("SELECT sid FROM server_sessions ORDER BY sid").all() as {
      sid: string;
    }[]
  ).map((r) => r.sid);
}

async function call(channel: string, sessionId: string | undefined, ...args: unknown[]) {
  const handler = bridge.getHandler(channel);
  if (!handler) throw new Error(`${channel} is not registered`);
  return (await handler({ sessionId } as unknown as HandlerContext, ...args)) as {
    ok?: boolean;
    error?: string;
    signedOut?: number;
    identity?: { isOwner: boolean };
  };
}

async function seed() {
  const owner = await identities.createLocalAccount("Owner", OLD, { isOwner: true });
  const guest = await identities.createLocalAccount("Guest", OLD);
  const google = identities.addIdentity({ provider: "google", subject: "g-123" });
  return { owner, guest, google };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-password-mgmt-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  identities = await import("../../server/auth/identities");
  reset = await import("../../server/auth/password-reset");
  tools = await import("../../main/assistant/tools");
  bridge = await import("../../main/host/bridge");
  if (!bridge.getHandler("server:setPassword")) {
    const { registerServerHandlers } = await import("../../main/ipc/server");
    registerServerHandlers();
  }
});

afterEach(() => {
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("resetLocalPassword", () => {
  it("replaces the password: the old one stops working, the new one works", async () => {
    const { guest } = await seed();
    const result = await reset.resetLocalPassword(guest.id, NEW);
    expect("error" in result).toBe(false);
    expect(await identities.verifyLocalLogin("guest", OLD)).toBeNull();
    expect((await identities.verifyLocalLogin("guest", NEW))?.id).toBe(guest.id);
  });

  it("signs out every other session of that account and keeps the excepted one", async () => {
    const { owner, guest } = await seed();
    putSession("sid-guest-a", guest.id);
    putSession("sid-guest-b", guest.id);
    putSession("sid-guest-here", guest.id);
    putSession("sid-owner", owner.id);

    const result = await reset.resetLocalPassword(guest.id, NEW, {
      keepSessionId: "sid-guest-here",
    });
    expect(result).toMatchObject({ ok: true, signedOut: 2 });
    // Somebody else's sessions are not this reset's business.
    expect(sessionIds()).toEqual(["sid-guest-here", "sid-owner"]);
  });

  it("refuses an identity that signs in through a provider", async () => {
    const { google } = await seed();
    const result = await reset.resetLocalPassword(google.id, NEW);
    expect("error" in result && result.error).toMatch(/google/);
    // Giving it a hash anyway would be a second way into that account.
    const row = db
      .getServerDb()
      .prepare("SELECT password_hash FROM server_identities WHERE id = ?")
      .get(google.id) as { password_hash: string | null };
    expect(row.password_hash).toBeNull();
  });

  it("applies the password policy and leaves the old password in place", async () => {
    const { guest } = await seed();
    const result = await reset.resetLocalPassword(guest.id, "short");
    expect("error" in result).toBe(true);
    expect((await identities.verifyLocalLogin("guest", OLD))?.id).toBe(guest.id);
  });

  it("does not take a non-string password", async () => {
    const { guest } = await seed();
    const result = await reset.resetLocalPassword(guest.id, ["a-long-enough-password"]);
    expect("error" in result).toBe(true);
  });
});

describe("server:setPassword", () => {
  it("lets the desktop window (no session) reset anyone, the owner included", async () => {
    const { owner } = await seed();
    const result = await call("server:setPassword", undefined, {
      identityId: owner.id,
      password: NEW,
    });
    expect(result.ok).toBe(true);
    expect((await identities.verifyLocalLogin("owner", NEW))?.isOwner).toBe(true);
  });

  it("refuses a signed-in non-owner, even for their own account", async () => {
    const { owner, guest } = await seed();
    putSession("sid-guest", guest.id);
    for (const target of [owner.id, guest.id]) {
      const result = await call("server:setPassword", "sid-guest", {
        identityId: target,
        password: NEW,
      });
      expect(result.error).toMatch(/owner/i);
    }
    expect(await identities.verifyLocalLogin("owner", NEW)).toBeNull();
    expect(await identities.verifyLocalLogin("guest", NEW)).toBeNull();
  });

  it("keeps the owner's own web session when they reset their own password", async () => {
    const { owner } = await seed();
    putSession("sid-owner-here", owner.id);
    putSession("sid-owner-laptop", owner.id);
    const result = await call("server:setPassword", "sid-owner-here", {
      identityId: owner.id,
      password: NEW,
    });
    expect(result).toMatchObject({ ok: true, signedOut: 1 });
    expect(sessionIds()).toEqual(["sid-owner-here"]);
  });
});

describe("web_server_set_password", () => {
  const ctx = (sessionId?: string) => ({ sessionId }) as unknown as AiToolContext;

  it("refuses a signed-in non-owner", async () => {
    const { owner, guest } = await seed();
    putSession("sid-guest", guest.id);
    const tool = tools.getToolByName("web_server_set_password");
    expect(tool?.kind).toBe("write-destructive");
    const result = (await tool!.run(
      { identity_id: owner.id, password: NEW },
      ctx("sid-guest")
    )) as { error?: string };
    expect(result.error).toMatch(/owner/i);
    expect(await identities.verifyLocalLogin("owner", NEW)).toBeNull();
  });

  it("resets for the owner", async () => {
    const { guest } = await seed();
    const result = (await tools
      .getToolByName("web_server_set_password")!
      .run({ identity_id: guest.id, password: NEW }, ctx(undefined))) as { ok?: boolean };
    expect(result.ok).toBe(true);
    expect((await identities.verifyLocalLogin("guest", NEW))?.id).toBe(guest.id);
  });
});

describe("adding a local account", () => {
  it("refuses an existing username instead of replacing its password", async () => {
    // The symptom this pins: "Add account" typed with the owner's name
    // reported success, added nobody, and changed the owner's password.
    const { owner } = await seed();
    for (const name of ["owner", "OWNER", " Owner "]) {
      const result = await call("server:allowIdentity", undefined, {
        provider: "local",
        subject: name,
        password: NEW,
      });
      expect(result.error).toMatch(/already exists/);
    }
    const tool = (await tools
      .getToolByName("web_server_allow_identity")!
      .run(
        { provider: "local", subject: "owner", password: NEW },
        { sessionId: undefined } as unknown as AiToolContext
      )) as { error?: string };
    expect(tool.error).toMatch(/already exists/);

    expect((await identities.verifyLocalLogin("owner", OLD))?.id).toBe(owner.id);
    expect(await identities.verifyLocalLogin("owner", NEW)).toBeNull();
    expect(identities.listIdentities().filter((i) => i.provider === "local")).toHaveLength(2);
  });

  it("adds a new one", async () => {
    await seed();
    const result = await call("server:allowIdentity", undefined, {
      provider: "local",
      subject: "Newcomer",
      password: NEW,
    });
    expect(result.ok).toBe(true);
    expect(await identities.verifyLocalLogin("newcomer", NEW)).not.toBeNull();
  });
});

describe("server:claimOwner", () => {
  it("creates the owner from the desktop window and consumes the claim token", async () => {
    expect(identities.getOrCreateClaimToken()).toBeTruthy();
    const result = await call("server:claimOwner", undefined, {
      username: "Desk Owner",
      password: NEW,
    });
    expect(result.ok).toBe(true);
    expect(result.identity?.isOwner).toBe(true);
    expect((await identities.verifyLocalLogin("desk owner", NEW))?.isOwner).toBe(true);
    expect(identities.getOrCreateClaimToken()).toBeNull();
    expect(
      db
        .getServerDb()
        .prepare("SELECT value FROM server_settings WHERE key = 'owner_claim_token'")
        .get()
    ).toBeUndefined();
  });

  it("is refused to any web caller — the claim token is the web's proof", async () => {
    const result = await call("server:claimOwner", "sid-anything", {
      username: "intruder",
      password: NEW,
    });
    expect(result.error).toBeTruthy();
    expect(identities.countIdentities()).toBe(0);
  });

  it("grants ownership once: a second claim is refused", async () => {
    await seed();
    const result = await call("server:claimOwner", undefined, {
      username: "second",
      password: NEW,
    });
    expect(result.error).toMatch(/already has an owner/);
    expect(identities.listIdentities().filter((i) => i.isOwner)).toHaveLength(1);
  });
});

describe("the owner recovery token", () => {
  it("is issued only when the flag is exactly \"1\"", async () => {
    await seed();
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const env = value === undefined ? {} : { IPODROCKS_RESET_OWNER: value };
      expect(reset.prepareOwnerReset(env).kind).toBe("off");
      expect(reset.ownerResetAvailable()).toBe(false);
    }
    const setup = reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" });
    expect(setup.kind).toBe("token");
    expect(reset.ownerResetAvailable()).toBe(true);
  });

  it("is wiped by a boot without the flag — forgetting the variable is not a standing way in", async () => {
    await seed();
    const setup = reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" });
    if (setup.kind !== "token") throw new Error("expected a token");
    reset.prepareOwnerReset({});
    expect(reset.ownerResetTokenMatches(setup.token)).toBe(false);
  });

  it("expires", async () => {
    await seed();
    const t0 = 1_000_000;
    const setup = reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" }, t0);
    if (setup.kind !== "token") throw new Error("expected a token");
    expect(reset.ownerResetTokenMatches(setup.token, t0 + 1000)).toBe(true);
    expect(
      reset.ownerResetTokenMatches(setup.token, t0 + reset.OWNER_RESET_TTL_MS + 1)
    ).toBe(false);
    expect(reset.ownerResetAvailable(t0 + reset.OWNER_RESET_TTL_MS + 1)).toBe(false);
  });

  it("matches only the exact token", async () => {
    await seed();
    const setup = reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" });
    if (setup.kind !== "token") throw new Error("expected a token");
    expect(reset.ownerResetTokenMatches(setup.token)).toBe(true);
    for (const wrong of ["", setup.token.slice(1), `${setup.token}x`, null, [setup.token]]) {
      expect(reset.ownerResetTokenMatches(wrong)).toBe(false);
    }
  });

  it("is not issued with no owner, or for an owner who signs in with a provider", async () => {
    expect(reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" }).kind).toBe("refused");
    identities.addIdentity({ provider: "google", subject: "g-owner", isOwner: true });
    const setup = reset.prepareOwnerReset({ IPODROCKS_RESET_OWNER: "1" });
    expect(setup.kind).toBe("refused");
    expect(reset.ownerResetAvailable()).toBe(false);
  });
});

describe("cli.ts", () => {
  it("lists accounts and refuses an unknown one or a bad command", async () => {
    await seed();
    const { main } = await import("../../server/cli");
    expect(await main(["list"])).toBe(0);
    expect(await main(["password", "nobody"])).toBe(1);
    expect(await main([])).toBe(2);
  });
});
