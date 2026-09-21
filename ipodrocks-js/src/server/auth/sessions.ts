import * as crypto from "crypto";
import { getServerDb } from "../db";
import { findIdentityById, type Identity } from "./identities";

/**
 * Reading and revoking the live logins.
 *
 * `SqliteSessionStore` owns the table for `express-session`'s benefit — get,
 * set, touch, destroy, one session at a time and keyed by an id the caller
 * already has. This module is the other half: the questions an *owner* asks
 * about the table as a whole ("who is signed in?", "sign that account out
 * everywhere"), which the store has no reason to answer.
 *
 * **A session id is the session store's key and is not printed.** Knowing one
 * is not by itself enough to forge the cookie — express-session signs it with
 * `IPODROCKS_SESSION_SECRET` — but it is one half of a credential and a list of
 * them has no legitimate reader. Everything here identifies a session by a
 * truncated SHA-256 instead, which is stable, displayable and reverses to
 * nothing. Revocation is by *identity*, which is the unit an owner actually
 * thinks in: "log this person out", not "destroy session a3f9".
 */

export interface ServerSessionInfo {
  /** A short, non-secret handle. Display only; nothing accepts it as input. */
  fingerprint: string;
  identityId: number | null;
  provider: string | null;
  subject: string | null;
  displayName: string | null;
  isOwner: boolean;
  /** Epoch ms. The store sweeps expired rows lazily, so a row can outlive this. */
  expiresAt: number;
}

interface SessionRow {
  sid: string;
  data: string;
  expires_at: number;
}

function fingerprint(sid: string): string {
  return crypto.createHash("sha256").update(sid).digest("hex").slice(0, 12);
}

function identityIdOf(row: SessionRow): number | null {
  try {
    const parsed = JSON.parse(row.data) as { identityId?: unknown };
    return typeof parsed.identityId === "number" ? parsed.identityId : null;
  } catch {
    // A session row this module cannot parse is still a session row: it is
    // listed as anonymous rather than dropped, because "there is a login here
    // I cannot explain" is exactly what an owner wants to see.
    return null;
  }
}

/**
 * Every unexpired session, newest expiry first.
 *
 * Sessions with no `identityId` are the ones express-session created for an
 * unauthenticated visitor — someone sitting on the login page. They are counted
 * and shown as anonymous rather than hidden, since a pile of them is the shape
 * a login-guessing run leaves behind.
 */
export function listServerSessions(): ServerSessionInfo[] {
  const rows = getServerDb()
    .prepare(
      "SELECT sid, data, expires_at FROM server_sessions " +
        "WHERE expires_at >= ? ORDER BY expires_at DESC"
    )
    .all(Date.now()) as SessionRow[];

  return rows.map((row) => {
    const identityId = identityIdOf(row);
    const identity: Identity | null =
      identityId === null ? null : findIdentityById(identityId);
    return {
      fingerprint: fingerprint(row.sid),
      identityId,
      provider: identity?.provider ?? null,
      subject: identity?.subject ?? null,
      displayName: identity?.displayName ?? null,
      isOwner: identity?.isOwner ?? false,
      expiresAt: row.expires_at,
    };
  });
}

/** The identity behind a live session id, or null. The owner gate on the IPC
 *  channels reads this: over the web a handler is given `ctx.sessionId` and
 *  nothing else, and "is this caller the owner" has to be answerable from it. */
export function identityForSessionId(sessionId: string): Identity | null {
  const row = getServerDb()
    .prepare("SELECT sid, data, expires_at FROM server_sessions WHERE sid = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  const identityId = identityIdOf(row);
  return identityId === null ? null : findIdentityById(identityId);
}

/**
 * The stable `"<provider>:<subject>"` string for a live session, or null.
 *
 * The same spelling `authenticatedSubject()` builds and `ctx.subject` carries
 * on the WebSocket, so a value recorded from an HTTP call compares equal to
 * one seen on a socket frame. Matched on the provider's `subject`, never the
 * email, which users can change.
 */
export function subjectForSessionId(sessionId: string): string | null {
  const identity = identityForSessionId(sessionId);
  return identity ? `${identity.provider}:${identity.subject}` : null;
}

/**
 * Destroys the sessions belonging to one identity. Returns how many.
 *
 * Scoped by identity rather than by session id on purpose — see the note at the
 * top. An owner revoking their own is a legitimate "sign me out of that other
 * browser" and is not blocked.
 */
export function revokeSessionsForIdentity(identityId: number): number {
  const rows = getServerDb()
    .prepare("SELECT sid, data, expires_at FROM server_sessions")
    .all() as SessionRow[];
  const victims = rows.filter((r) => identityIdOf(r) === identityId).map((r) => r.sid);
  if (victims.length === 0) return 0;
  const stmt = getServerDb().prepare("DELETE FROM server_sessions WHERE sid = ?");
  const run = getServerDb().transaction((sids: string[]) => {
    for (const sid of sids) stmt.run(sid);
  });
  run(victims);
  return victims.length;
}

/** Destroys every session, including the caller's. "Sign everyone out". */
export function revokeAllSessions(): number {
  const info = getServerDb().prepare("DELETE FROM server_sessions").run();
  return info.changes;
}

/**
 * The owner gate for everything that manages the allowlist — one copy, called
 * by `ipc/server.ts`'s handlers and by `assistant/tools.ts`'s `web_server_*`
 * tools.
 *
 * `/api/invoke` checks that a caller is *authenticated* and nothing more, which
 * is right for every other channel: anyone on the allowlist is a full user of
 * the app by design. The allowlist is the exception, because it is the gate
 * itself — a non-owner who could revoke identities could remove the owner's
 * ability to remove *them*. The HTTP routes for the same operations have always
 * been `requireOwner`; the IPC channels had to match, or adding them would have
 * been a privilege escalation dressed as a convenience.
 *
 * **`undefined` means Electron IPC**, i.e. the desktop window on the machine
 * holding the database. There is no identity to check and nothing a gate could
 * protect — that caller can edit the file directly. Only a web session is gated.
 *
 * It lives here, and not in either caller, for the reason CLAUDE.md's debt table
 * gives about conflict resolution: a second copy is where the `manual` branch
 * went missing. A gate with two implementations has one that is weaker.
 */
export function denyIfNotOwner(
  sessionId: string | undefined
): { error: string } | null {
  if (sessionId === undefined) return null;
  const identity = identityForSessionId(sessionId);
  if (!identity?.isOwner) {
    return { error: "Only the server's owner can manage who may sign in." };
  }
  return null;
}
