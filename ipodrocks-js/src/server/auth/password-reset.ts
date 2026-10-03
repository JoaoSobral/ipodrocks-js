import * as crypto from "crypto";
import { getServerDb, getSetting, setSetting } from "../db";
import {
  findIdentityById,
  listIdentities,
  setLocalPassword,
  type Identity,
} from "./identities";
import { validatePassword } from "./passwords";
import { revokeSessionsForIdentity } from "./sessions";

/**
 * Setting a local account's password after it exists — the owner resetting
 * someone's, a user changing their own, the `cli.ts` recovery command and the
 * log-printed owner recovery token all end here.
 *
 * **`resetLocalPassword()` is the only writer**, for the reason CLAUDE.md gives
 * about gates with two implementations: one of them is weaker. Every caller
 * gets the same three guarantees — the password policy, a refusal for an
 * identity that signs in through a provider (it has no password, and quietly
 * giving it one would add a second way into that account), and every *other*
 * session of that identity signed out, since "I changed my password" is most
 * often "somebody else knows the old one".
 */

export type PasswordResetResult =
  | { ok: true; identity: Identity; signedOut: number }
  | { error: string };

export async function resetLocalPassword(
  identityId: number,
  password: unknown,
  opts: { keepSessionId?: string } = {}
): Promise<PasswordResetResult> {
  const identity = findIdentityById(identityId);
  if (!identity) return { error: "No such account." };
  if (identity.provider !== "local") {
    return {
      error:
        `${identity.displayName ?? identity.subject} signs in with ` +
        `${identity.provider}, so there is no password to set.`,
    };
  }
  const bad = validatePassword(password);
  if (bad) return bad;
  await setLocalPassword(identity.id, String(password));
  const signedOut = revokeSessionsForIdentity(identity.id, opts.keepSessionId);
  return { ok: true, identity, signedOut };
}

export function findLocalAccount(username: string): Identity | null {
  const subject = username.trim().toLowerCase();
  return (
    listIdentities().find((i) => i.provider === "local" && i.subject === subject) ?? null
  );
}

export function findOwner(): Identity | null {
  return listIdentities().find((i) => i.isOwner) ?? null;
}

// ---------------------------------------------------------------------------
// Owner recovery token
//
// For a headless install where nobody has a shell to run `cli.ts`: start the
// daemon with `IPODROCKS_RESET_OWNER=1` and it prints a one-time token, which
// the login page trades for a new owner password. Same trust rule as the claim
// token — whoever reads the log owns the machine.
//
// The token is wiped on every boot *without* the flag, and expires on its own,
// so forgetting to remove the variable costs at most one window, never a
// standing way in.
// ---------------------------------------------------------------------------

const OWNER_RESET_KEY = "owner_reset_token";
export const OWNER_RESET_TTL_MS = 30 * 60 * 1000;

interface StoredResetToken {
  token: string;
  expiresAt: number;
}

function readResetToken(): StoredResetToken | null {
  const raw = getSetting(OWNER_RESET_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredResetToken>;
    if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function clearOwnerResetToken(): void {
  getServerDb().prepare("DELETE FROM server_settings WHERE key = ?").run(OWNER_RESET_KEY);
}

export type OwnerResetSetup =
  | { kind: "off" }
  | { kind: "token"; token: string; owner: Identity }
  | { kind: "refused"; reason: string };

/**
 * Called once at server start. Issues a token only when the flag is exactly
 * `"1"`; otherwise removes any token a previous boot left behind.
 */
export function prepareOwnerReset(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now()
): OwnerResetSetup {
  if (env.IPODROCKS_RESET_OWNER !== "1") {
    clearOwnerResetToken();
    return { kind: "off" };
  }
  clearOwnerResetToken();
  const owner = findOwner();
  if (!owner) {
    return {
      kind: "refused",
      reason: "this server has no owner yet — use the claim token instead",
    };
  }
  if (owner.provider !== "local") {
    return {
      kind: "refused",
      reason: `the owner signs in with ${owner.provider}, which has no password to reset`,
    };
  }
  const token = crypto.randomBytes(24).toString("base64url");
  setSetting(
    OWNER_RESET_KEY,
    JSON.stringify({ token, expiresAt: now + OWNER_RESET_TTL_MS } satisfies StoredResetToken)
  );
  return { kind: "token", token, owner };
}

export function ownerResetAvailable(now: number = Date.now()): boolean {
  const stored = readResetToken();
  return stored !== null && stored.expiresAt > now;
}

export function ownerResetTokenMatches(candidate: unknown, now: number = Date.now()): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const stored = readResetToken();
  if (!stored || stored.expiresAt <= now) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored.token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
