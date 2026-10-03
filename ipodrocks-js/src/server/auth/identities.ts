import * as crypto from "crypto";
import { getServerDb, getSetting, setSetting } from "../db";
import { hashPassword, verifyPassword } from "./passwords";
import type { OAuthProvider, Provider } from "../../shared/auth-providers";

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

export type { Provider } from "../../shared/auth-providers";

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

/**
 * Adds a provider account to the allowlist as a new, non-owner identity — the
 * one implementation behind `server:allowIdentity`, `POST /identities`, Rocksy's
 * `web_server_allow_identity` and an approved access request.
 *
 * Refuses a subject that is already a *link*. Admitting it as well would give
 * one person two rows and two data scopes, and which one a login landed in
 * would depend on lookup order.
 */
export function allowProviderIdentity(input: {
  provider: OAuthProvider;
  subject: string;
  email?: string | null;
  displayName?: string | null;
}): { identity: Identity } | { error: string } {
  const link = findLink(input.provider, input.subject);
  if (link) {
    return {
      error:
        "That account is already a sign-in method for another account on this " +
        "server. Remove the link first if it should be an account of its own.",
    };
  }
  // Never `isOwner`. Ownership is claimed once, with the one-time token, and
  // there is deliberately no second way to grant it.
  return {
    identity: addIdentity({
      provider: input.provider,
      subject: input.subject,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
    }),
  };
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

/**
 * Adds a *new* local account — the one implementation behind "Add account" in
 * Settings, `server:allowIdentity`, `POST /identities` and Rocksy's
 * `web_server_allow_identity`.
 *
 * Refuses a username that already exists. `addIdentity()` upserts, so going
 * straight to `createLocalAccount()` with an existing name silently replaced
 * that account's password — the owner's included — while the form reported a
 * new account. Changing a password is `resetLocalPassword()`'s job, which also
 * signs the account's other browsers out.
 *
 * The hash is computed first so the existence check and the insert have no
 * `await` between them.
 */
export async function addNewLocalAccount(
  username: string,
  password: string
): Promise<{ identity: Identity } | { error: string }> {
  const name = username.trim();
  if (name.length < 2) return { error: "Username must be at least 2 characters." };
  const hash = await hashPassword(password);
  if (findIdentity("local", name.toLowerCase())) {
    return {
      error: `An account named "${name}" already exists. Use Set password to change its password.`,
    };
  }
  return {
    identity: addIdentity({
      provider: "local",
      subject: name.toLowerCase(),
      displayName: name,
      passwordHash: hash,
    }),
  };
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
 *
 * Lookup order: an identity of its own, then a link to one, then the
 * first-run claim. A refusal of a provider login on a server that already has
 * an owner is recorded as an access request, so the owner can admit that
 * person without ever learning their provider user id.
 */
export function authorizeIdentity(input: {
  provider: Provider;
  subject: string;
  email?: string | null;
  /** Only a verified address is ever stored on an identity. */
  emailVerified?: boolean;
  displayName?: string | null;
  claimToken?: unknown;
}): { identity: Identity } | { error: string } {
  const email = input.emailVerified ? (input.email ?? null) : null;
  const existing = findIdentity(input.provider, input.subject);
  if (existing) {
    // Keep the profile fresh, but never re-derive `is_owner` from the provider.
    addIdentity({
      provider: input.provider,
      subject: input.subject,
      email,
      displayName: input.displayName,
      isOwner: existing.isOwner,
    });
    markLogin(existing.id);
    return { identity: existing };
  }

  const link = findLink(input.provider, input.subject);
  if (link) {
    const identity = findIdentityById(link.identityId);
    // The FK cascades, so a link without its identity cannot exist; refuse
    // rather than assume if it somehow does.
    if (identity) {
      markLinkLogin(link.id, email, input.displayName ?? null);
      markLogin(identity.id);
      return { identity };
    }
  }

  if (countIdentities() === 0) {
    if (!claimTokenMatches(input.claimToken)) {
      return {
        error:
          "This server has no owner yet. Sign in again with the claim token " +
          "printed in the server log.",
      };
    }
    const identity = addIdentity({
      provider: input.provider,
      subject: input.subject,
      email,
      displayName: input.displayName,
      isOwner: true,
    });
    consumeClaimToken();
    markLogin(identity.id);
    return { identity };
  }

  if (input.provider !== "local") {
    recordAccessRequest({
      provider: input.provider,
      subject: input.subject,
      email: input.email ?? null,
      emailVerified: input.emailVerified === true,
      displayName: input.displayName ?? null,
    });
  }
  return { error: "This account is not authorized to use this server." };
}

// ---------------------------------------------------------------------------
// Linked sign-in methods
// ---------------------------------------------------------------------------

export interface IdentityLink {
  id: number;
  identityId: number;
  provider: OAuthProvider;
  subject: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

interface LinkRow {
  id: number;
  identity_id: number;
  provider: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  last_login_at: string | null;
}

const LINK_COLUMNS =
  "id, identity_id, provider, subject, email, display_name, created_at, last_login_at";

function toLink(row: LinkRow): IdentityLink {
  return {
    id: row.id,
    identityId: row.identity_id,
    provider: row.provider as OAuthProvider,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function findLink(provider: Provider, subject: string): IdentityLink | null {
  const row = getServerDb()
    .prepare(
      `SELECT ${LINK_COLUMNS} FROM server_identity_links WHERE provider = ? AND subject = ?`
    )
    .get(provider, subject) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

export function findLinkById(id: number): IdentityLink | null {
  const row = getServerDb()
    .prepare(`SELECT ${LINK_COLUMNS} FROM server_identity_links WHERE id = ?`)
    .get(id) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

/** One identity's links, or every link when `identityId` is omitted. */
export function listLinks(identityId?: number): IdentityLink[] {
  const db = getServerDb();
  const rows = (
    identityId === undefined
      ? db.prepare(`SELECT ${LINK_COLUMNS} FROM server_identity_links ORDER BY id`).all()
      : db
          .prepare(
            `SELECT ${LINK_COLUMNS} FROM server_identity_links WHERE identity_id = ? ORDER BY id`
          )
          .all(identityId)
  ) as LinkRow[];
  return rows.map(toLink);
}

export type IdentityWithLinks = Identity & { links: IdentityLink[] };

/** The allowlist with each identity's linked sign-in methods — the shape every
 *  owner-facing reader uses, so an owner always sees every way in. */
export function listIdentitiesWithLinks(): IdentityWithLinks[] {
  const links = listLinks();
  return listIdentities().map((i) => ({
    ...i,
    links: links.filter((l) => l.identityId === i.id),
  }));
}

/**
 * Attaches a provider account to an identity as another way to sign in.
 *
 * **Only the link callback may call this**, and only for the identity the
 * session was already authenticated as — that is what makes a link "another key
 * to the same door" rather than a second route onto the allowlist. It never
 * creates or promotes an identity.
 *
 * Refuses a subject that is already in use anywhere: as an identity of its
 * own (one person, two data scopes) or as a link, including to this same
 * identity (nothing to do, and saying so beats a silent success).
 */
export function addLink(input: {
  identityId: number;
  provider: OAuthProvider;
  subject: string;
  email?: string | null;
  displayName?: string | null;
}): { link: IdentityLink } | { error: "already_used" | "no_identity" } {
  if (!findIdentityById(input.identityId)) return { error: "no_identity" };
  if (findIdentity(input.provider, input.subject) || findLink(input.provider, input.subject)) {
    return { error: "already_used" };
  }
  getServerDb()
    .prepare(
      "INSERT INTO server_identity_links (identity_id, provider, subject, email, display_name) " +
        "VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      input.identityId,
      input.provider,
      input.subject,
      input.email ?? null,
      input.displayName ?? null
    );
  // A pending request for the same account is answered now.
  getServerDb()
    .prepare("DELETE FROM server_access_requests WHERE provider = ? AND subject = ?")
    .run(input.provider, input.subject);
  const link = findLink(input.provider, input.subject);
  if (!link) throw new Error("Link insert did not take");
  return { link };
}

export function removeLink(id: number): { ok: true } | { error: string } {
  const info = getServerDb().prepare("DELETE FROM server_identity_links WHERE id = ?").run(id);
  return info.changes > 0 ? { ok: true } : { error: "No such sign-in method" };
}

function markLinkLogin(id: number, email: string | null, displayName: string | null): void {
  getServerDb()
    .prepare(
      "UPDATE server_identity_links SET last_login_at = datetime('now'), " +
        "email = COALESCE(?, email), display_name = COALESCE(?, display_name) WHERE id = ?"
    )
    .run(email, displayName, id);
}

// ---------------------------------------------------------------------------
// Access requests
// ---------------------------------------------------------------------------

/** How many refused logins are kept, newest first. */
export const MAX_ACCESS_REQUESTS = 50;
/** How long a refused login is kept without a retry. */
export const ACCESS_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessRequest {
  id: number;
  provider: OAuthProvider;
  subject: string;
  /** As the provider sent it. Shown with `emailVerified`; never matched on. */
  email: string | null;
  emailVerified: boolean;
  /** Chosen by the person signing in — anyone can call themselves anything. */
  displayName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
}

interface AccessRequestRow {
  id: number;
  provider: string;
  subject: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  first_seen_at: number;
  last_seen_at: number;
  attempts: number;
}

function toAccessRequest(row: AccessRequestRow): AccessRequest {
  return {
    id: row.id,
    provider: row.provider as OAuthProvider,
    subject: row.subject,
    email: row.email,
    emailVerified: row.email_verified === 1,
    displayName: row.display_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    attempts: row.attempts,
  };
}

function pruneAccessRequests(now: number): void {
  const db = getServerDb();
  db.prepare("DELETE FROM server_access_requests WHERE last_seen_at < ?").run(
    now - ACCESS_REQUEST_TTL_MS
  );
  db.prepare(
    "DELETE FROM server_access_requests WHERE id NOT IN (" +
      "SELECT id FROM server_access_requests ORDER BY last_seen_at DESC, id DESC LIMIT ?)"
  ).run(MAX_ACCESS_REQUESTS);
}

/**
 * Records a refused provider login. Anyone who can complete a login at the
 * provider can write here, so the table is bounded on every write: rows older
 * than {@link ACCESS_REQUEST_TTL_MS} go, then everything past the newest
 * {@link MAX_ACCESS_REQUESTS}. A repeat from the same account bumps its row
 * instead of adding one.
 */
export function recordAccessRequest(
  input: {
    provider: OAuthProvider;
    subject: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
  },
  now: number = Date.now()
): void {
  const db = getServerDb();
  db.transaction(() => {
    db.prepare(
      "INSERT INTO server_access_requests " +
        "(provider, subject, email, email_verified, display_name, first_seen_at, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(provider, subject) DO UPDATE SET " +
        "email = excluded.email, email_verified = excluded.email_verified, " +
        "display_name = excluded.display_name, last_seen_at = excluded.last_seen_at, " +
        "attempts = server_access_requests.attempts + 1"
    ).run(
      input.provider,
      input.subject,
      input.email,
      input.emailVerified ? 1 : 0,
      input.displayName,
      now,
      now
    );
    pruneAccessRequests(now);
  })();
}

export function listAccessRequests(now: number = Date.now()): AccessRequest[] {
  pruneAccessRequests(now);
  const rows = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, email_verified, display_name, " +
        "first_seen_at, last_seen_at, attempts FROM server_access_requests " +
        "ORDER BY last_seen_at DESC, id DESC"
    )
    .all() as AccessRequestRow[];
  return rows.map(toAccessRequest);
}

export function dismissAccessRequest(id: number): { ok: true } | { error: string } {
  const info = getServerDb().prepare("DELETE FROM server_access_requests WHERE id = ?").run(id);
  return info.changes > 0 ? { ok: true } : { error: "No such access request" };
}

/**
 * Admits the account behind a refused login as a new, non-owner identity, and
 * drops the request. Goes through {@link allowProviderIdentity} like every
 * other way of adding someone, so a subject that has since become a link is
 * refused here too. An unverified email is not carried onto the identity.
 */
export function approveAccessRequest(
  id: number
): { identity: Identity } | { error: string } {
  const row = getServerDb()
    .prepare(
      "SELECT id, provider, subject, email, email_verified, display_name, " +
        "first_seen_at, last_seen_at, attempts FROM server_access_requests WHERE id = ?"
    )
    .get(id) as AccessRequestRow | undefined;
  if (!row) return { error: "No such access request" };
  const request = toAccessRequest(row);
  if (findIdentity(request.provider, request.subject)) {
    dismissAccessRequest(id);
    return { error: "That account is already on the allowlist." };
  }
  const outcome = allowProviderIdentity({
    provider: request.provider,
    subject: request.subject,
    email: request.emailVerified ? request.email : null,
    displayName: request.displayName,
  });
  if ("identity" in outcome) dismissAccessRequest(id);
  return outcome;
}
