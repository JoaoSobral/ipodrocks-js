import * as crypto from "crypto";
import { getServerDb, getSetting, setSetting } from "../db";
import { hashPassword, verifyPassword } from "./passwords";

/**
 * The identity allowlist.
 *
 * **OAuth proves who someone is, not that they are allowed in.** Anyone on
 * earth can complete a Google login against this server's client id and arrive
 * at the callback with a perfectly valid profile. Without the check below,
 * configuring a provider is equivalent to publishing the library.
 *
 * Bootstrapping is the awkward part, because the first person to log in has to
 * be trusted by something other than the (empty) list. That something is a
 * one-time claim token printed to the server log: whoever can read the log owns
 * the machine, so binding the first identity to it grants nothing an attacker
 * did not already have. The token is consumed by the first successful claim and
 * never printed again.
 */

export type Provider = "google" | "github" | "facebook" | "local";

export interface Identity {
  id: number;
  provider: Provider;
  subject: string;
  email: string | null;
  displayName: string | null;
  isOwner: boolean;
}

interface IdentityRow {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  is_owner: number;
  password_hash: string | null;
}

const CLAIM_TOKEN_KEY = "owner_claim_token";

function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    provider: row.provider as Provider,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    isOwner: row.is_owner === 1,
  };
}

export function countIdentities(): number {
  const row = getServerDb()
    .prepare("SELECT COUNT(*) AS n FROM server_identities")
    .get() as { n: number };
  return row.n;
}

export function listIdentities(): Identity[] {
  const rows = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, display_name, is_owner, password_hash " +
        "FROM server_identities ORDER BY is_owner DESC, id ASC"
    )
    .all() as IdentityRow[];
  return rows.map(toIdentity);
}

export function findIdentity(provider: Provider, subject: string): Identity | null {
  const row = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, display_name, is_owner, password_hash " +
        "FROM server_identities WHERE provider = ? AND subject = ?"
    )
    .get(provider, subject) as IdentityRow | undefined;
  return row ? toIdentity(row) : null;
}

export function findIdentityById(id: number): Identity | null {
  const row = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, display_name, is_owner, password_hash " +
        "FROM server_identities WHERE id = ?"
    )
    .get(id) as IdentityRow | undefined;
  return row ? toIdentity(row) : null;
}

export function markLogin(id: number): void {
  getServerDb()
    .prepare("UPDATE server_identities SET last_login_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function addIdentity(input: {
  provider: Provider;
  subject: string;
  email?: string | null;
  displayName?: string | null;
  isOwner?: boolean;
  passwordHash?: string | null;
}): Identity {
  getServerDb()
    .prepare(
      "INSERT INTO server_identities " +
        "(provider, subject, email, display_name, is_owner, password_hash) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(provider, subject) DO UPDATE SET " +
        "email = excluded.email, display_name = excluded.display_name, " +
        // COALESCE, not a plain assignment. A caller that supplies a hash means
        // it — `createLocalAccount()` on a username that already exists used to
        // report "X can now sign in with that password" and leave the old one
        // in place, because this clause did not touch the column. A caller that
        // supplies none (every provider login, which refreshes the profile on
        // the way through) must not wipe one that is already there.
        "password_hash = COALESCE(excluded.password_hash, server_identities.password_hash)"
    )
    .run(
      input.provider,
      input.subject,
      input.email ?? null,
      input.displayName ?? null,
      input.isOwner ? 1 : 0,
      input.passwordHash ?? null
    );
  const identity = findIdentity(input.provider, input.subject);
  if (!identity) throw new Error("Identity insert did not take");
  return identity;
}

export function removeIdentity(id: number): { error: string } | { ok: true } {
  const identity = findIdentityById(id);
  if (!identity) return { error: "No such identity" };
  if (identity.isOwner) {
    // Removing the owner leaves a server whose allowlist can no longer be
    // edited by anyone: every route that manages the list requires an owner.
    return { error: "The owner identity cannot be removed" };
  }
  getServerDb().prepare("DELETE FROM server_identities WHERE id = ?").run(id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Owner claim token
// ---------------------------------------------------------------------------

/**
 * Returns the claim token, generating one on first call. Returns null once an
 * owner exists — there is nothing left to claim, and re-printing a live token
 * after the fact is how a "one-time" secret becomes a permanent backdoor.
 */
export function getOrCreateClaimToken(): string | null {
  if (countIdentities() > 0) return null;
  const existing = getSetting(CLAIM_TOKEN_KEY);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString("base64url");
  setSetting(CLAIM_TOKEN_KEY, token);
  return token;
}

export function claimTokenMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const stored = getSetting(CLAIM_TOKEN_KEY);
  if (!stored) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function consumeClaimToken(): void {
  getServerDb()
    .prepare("DELETE FROM server_settings WHERE key = ?")
    .run(CLAIM_TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Local password accounts
// ---------------------------------------------------------------------------

export async function createLocalAccount(
  username: string,
  password: string,
  opts: { isOwner?: boolean } = {}
): Promise<Identity> {
  const subject = username.trim().toLowerCase();
  const hash = await hashPassword(password);
  return addIdentity({
    provider: "local",
    subject,
    displayName: username.trim(),
    isOwner: opts.isOwner ?? false,
    passwordHash: hash,
  });
}

export async function setLocalPassword(id: number, password: string): Promise<void> {
  const hash = await hashPassword(password);
  getServerDb()
    .prepare("UPDATE server_identities SET password_hash = ? WHERE id = ?")
    .run(hash, id);
}

/**
 * Verifies a local login. Always runs a scrypt derivation, even for a username
 * that does not exist, so the response time does not distinguish "no such user"
 * from "wrong password" — the enumeration oracle that usually survives a
 * carefully worded error message.
 */
export async function verifyLocalLogin(
  username: string,
  password: string
): Promise<Identity | null> {
  const subject = String(username ?? "").trim().toLowerCase();
  const row = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, display_name, is_owner, password_hash " +
        "FROM server_identities WHERE provider = 'local' AND subject = ?"
    )
    .get(subject) as IdentityRow | undefined;

  const stored =
    row?.password_hash ??
    // A well-formed hash of a value nobody can present. Same cost, no match.
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
      Buffer.alloc(64).toString("base64");

  const ok = await verifyPassword(String(password ?? ""), stored);
  if (!ok || !row) return null;
  return toIdentity(row);
}

/**
 * The gate every provider callback passes through.
 *
 * `claimToken` is only consulted when the allowlist is empty, so a leaked token
 * cannot be replayed to add a second identity later.
 */
export function authorizeIdentity(input: {
  provider: Provider;
  subject: string;
  email?: string | null;
  displayName?: string | null;
  claimToken?: unknown;
}): { identity: Identity } | { error: string } {
  const existing = findIdentity(input.provider, input.subject);
  if (existing) {
    // Keep the profile fresh, but never re-derive `is_owner` from the provider.
    addIdentity({ ...input, isOwner: existing.isOwner });
    markLogin(existing.id);
    return { identity: existing };
  }

  if (countIdentities() === 0) {
    if (!claimTokenMatches(input.claimToken)) {
      return {
        error:
          "This server has no owner yet. Sign in again with the claim token " +
          "printed in the server log.",
      };
    }
    const identity = addIdentity({ ...input, isOwner: true });
    consumeClaimToken();
    markLogin(identity.id);
    return { identity };
  }

  return { error: "This account is not authorized to use this server." };
}
