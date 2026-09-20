/**
 * Regression — the allowlist is the gate, so managing it is owner-only, and
 * Rocksy is not a way around that.
 *
 * `/api/invoke` checks that a caller is *authenticated* and nothing else, which
 * is right for every channel but these. Anyone on the allowlist is a full user
 * of the app by design; the allowlist itself is different, because a non-owner
 * who could revoke identities could remove the owner's ability to remove them.
 *
 * `tests/e2e/web-identities.test.ts` pins the IPC channels over a real daemon
 * with real cookies. This file pins the other caller — **the `web_server_*`
 * tools** — because a tool runs in the main process with no HTTP request
 * anywhere near it, and `AiToolContext.sessionId` is the only thing that
 * carries "who is asking" that far. Wiring it and then forgetting to read it
 * would leave every tool here wide open to any allowlisted user, with nothing
 * in the e2e suite to notice.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";
import type { AiToolContext } from "../../main/assistant/tools";

let dataDir: string;
let db: typeof import("../../server/db");
let identities: typeof import("../../server/auth/identities");
let sessions: typeof import("../../server/auth/sessions");
let tools: typeof import("../../main/assistant/tools");

/** Writes a session row the way `SqliteSessionStore.set()` does. */
function putSession(sid: string, identityId: number | null, expiresInMs = 60_000) {
  db.getServerDb()
    .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
    .run(
      sid,
      JSON.stringify(identityId === null ? {} : { identityId }),
      Date.now() + expiresInMs
    );
}

function ctxFor(sessionId?: string): AiToolContext {
  // None of the gated tools touch anything else on the context before the gate.
  return { sessionId } as unknown as AiToolContext;
}

const GATED = [
  "web_server_list_identities",
  "web_server_list_sessions",
  "web_server_allow_identity",
  "web_server_revoke_identity",
  "web_server_revoke_sessions",
] as const;

const ARGS: Record<string, Record<string, unknown>> = {
  web_server_list_identities: {},
  web_server_list_sessions: {},
  web_server_allow_identity: {
    provider: "local",
    subject: "intruder",
    password: "a-long-enough-password",
  },
  web_server_revoke_identity: { identity_id: 1 },
  web_server_revoke_sessions: { all: true },
};

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-owner-gate-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  identities = await import("../../server/auth/identities");
  sessions = await import("../../server/auth/sessions");
  tools = await import("../../main/assistant/tools");
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

describe("denyIfNotOwner", () => {
  it("admits a call with no session — that is Electron IPC", () => {
    // The desktop window on the machine holding the database. There is no
    // identity to check and nothing a gate could protect: that caller can edit
    // the file directly.
    expect(sessions.denyIfNotOwner(undefined)).toBeNull();
  });

  it("admits the owner's session and refuses an ordinary one", () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    putSession("sid-owner", owner.id);
    putSession("sid-guest", guest.id);

    expect(sessions.denyIfNotOwner("sid-owner")).toBeNull();
    expect(sessions.denyIfNotOwner("sid-guest")?.error).toMatch(/owner/i);
  });

  it("refuses an unknown, anonymous or expired session", () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    putSession("sid-anon", null);
    // An owner session that has run out is not an owner session. The store
    // sweeps lazily, so the row is still there to be read.
    putSession("sid-stale", owner.id, -1000);

    expect(sessions.denyIfNotOwner("sid-nonexistent")?.error).toMatch(/owner/i);
    expect(sessions.denyIfNotOwner("sid-anon")?.error).toMatch(/owner/i);
    expect(sessions.denyIfNotOwner("sid-stale")?.error).toMatch(/owner/i);
  });
});

describe("the web_server_* allowlist tools", () => {
  it("every one of them refuses a signed-in non-owner", async () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    const guest = identities.addIdentity({ provider: "local", subject: "guest" });
    putSession("sid-guest", guest.id);

    for (const name of GATED) {
      const tool = tools.getToolByName(name);
      expect(tool, `${name} is registered`).toBeTruthy();
      const result = (await tool!.run(ARGS[name], ctxFor("sid-guest"))) as {
        error?: string;
      };
      expect(result.error, `${name} must refuse a non-owner`).toMatch(/owner/i);
    }

    // And nothing the loop attempted took effect.
    const after = identities.listIdentities();
    expect(after.find((i) => i.subject === "intruder")).toBeUndefined();
    expect(after.find((i) => i.id === owner.id)).toBeTruthy();
    expect(sessions.listServerSessions()).toHaveLength(1);
  });

  it("lets the owner through", async () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    putSession("sid-owner", owner.id);

    const listed = (await tools
      .getToolByName("web_server_list_identities")!
      .run({}, ctxFor("sid-owner"))) as { identities?: unknown[]; error?: string };
    expect(listed.error).toBeUndefined();
    expect(listed.identities).toHaveLength(1);
  });

  it("never grants ownership, even to an owner asking for it", async () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    putSession("sid-owner", owner.id);

    // Ownership is claimed once, against the one-time token printed to the
    // server log. A second route to it would make that token pointless, so the
    // tool has no parameter for it and passing one anyway changes nothing.
    const added = (await tools.getToolByName("web_server_allow_identity")!.run(
      {
        provider: "google",
        subject: "someone-else",
        is_owner: true,
        isOwner: true,
      },
      ctxFor("sid-owner")
    )) as { identity?: { isOwner: boolean }; error?: string };

    expect(added.error).toBeUndefined();
    expect(added.identity?.isOwner).toBe(false);
  });

  it("refuses to remove the owner, which would leave an uneditable allowlist", async () => {
    const owner = identities.addIdentity({
      provider: "local",
      subject: "owner",
      isOwner: true,
    });
    putSession("sid-owner", owner.id);

    const res = (await tools
      .getToolByName("web_server_revoke_identity")!
      .run({ identity_id: owner.id }, ctxFor("sid-owner"))) as { error?: string };
    expect(res.error).toBeTruthy();
    expect(identities.findIdentityById(owner.id)).toBeTruthy();
  });
});

describe("listServerSessions", () => {
  it("shows an unparseable row as anonymous rather than dropping it", () => {
    // "There is a login here I cannot explain" is exactly what an owner needs
    // to see; a silent omission is the one behaviour that would hide it.
    db.getServerDb()
      .prepare("INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?)")
      .run("sid-corrupt", "{not json", Date.now() + 60_000);

    const listed = sessions.listServerSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].identityId).toBeNull();
  });

  it("never returns a session id, only a fingerprint of one", () => {
    putSession("sid-secret-value", null);
    const listed = sessions.listServerSessions();
    expect(JSON.stringify(listed)).not.toContain("sid-secret-value");
    expect(listed[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("omits an expired row the store has not swept yet", () => {
    putSession("sid-live", null);
    putSession("sid-dead", null, -1000);
    expect(sessions.listServerSessions()).toHaveLength(1);
  });
});
