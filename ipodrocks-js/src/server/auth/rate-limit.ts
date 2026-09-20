import { getServerDb } from "../db";

/**
 * Failed-login rate limiting with lockout, in SQLite rather than memory.
 *
 * In memory it would reset on every restart, which on a daemon someone is
 * actively probing is a restart loop away from no limit at all. The table is
 * swept on each check rather than by a timer, so an idle server does no work.
 *
 * Every attempt is counted against *two* buckets — the remote address and the
 * account being attempted. One IP spraying many accounts trips the first; a
 * botnet targeting one account trips the second. Checking only one leaves the
 * other wide open.
 */

export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * The two buckets deliberately have different ceilings.
 *
 * The account bucket is the tight one: ten wrong passwords for one account is
 * an attack, and locking that account costs its owner fifteen minutes.
 *
 * The address bucket is far looser, and has to be. Everyone in a household
 * shares an address, and behind a reverse proxy that is not configured in
 * `trustedProxies` *every* request shares one — so a ceiling of ten there
 * would let one person fat-fingering their password lock out the whole
 * installation. It is still worth having: it is what catches a single host
 * spraying one guess across many accounts, which the per-account counter
 * never sees.
 */
export const MAX_ATTEMPTS_PER_ACCOUNT = 10;
export const MAX_ATTEMPTS_PER_ADDRESS = 60;

function limitFor(bucket: string): number {
  return bucket.startsWith("ip:")
    ? MAX_ATTEMPTS_PER_ADDRESS
    : MAX_ATTEMPTS_PER_ACCOUNT;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the caller may try again. Rendered into `Retry-After`. */
  retryAfterSeconds: number;
  remaining: number;
}

function sweep(now: number): void {
  getServerDb()
    .prepare("DELETE FROM server_login_attempts WHERE attempted_at < ?")
    .run(now - Math.max(WINDOW_MS, LOCKOUT_MS));
}

function countIn(bucket: string, since: number): { n: number; newest: number } {
  const row = getServerDb()
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(MAX(attempted_at), 0) AS newest " +
        "FROM server_login_attempts WHERE bucket = ? AND attempted_at >= ?"
    )
    .get(bucket, since) as { n: number; newest: number };
  return row;
}

/** Checks without recording. Call before doing the expensive verification. */
export function checkRateLimit(
  buckets: string[],
  now = Date.now()
): RateLimitVerdict {
  sweep(now);
  let worst: RateLimitVerdict = {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: MAX_ATTEMPTS_PER_ACCOUNT,
  };
  for (const bucket of buckets) {
    const limit = limitFor(bucket);
    const { n, newest } = countIn(bucket, now - WINDOW_MS);
    if (n >= limit) {
      const until = newest + LOCKOUT_MS;
      const retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
      // Report the longest wait of any tripped bucket, so a caller told to
      // come back in N seconds is not refused again on arrival.
      if (!worst.allowed && worst.retryAfterSeconds >= retryAfterSeconds) continue;
      worst = { allowed: false, retryAfterSeconds, remaining: 0 };
    } else if (worst.allowed) {
      worst = {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.min(worst.remaining, limit - n),
      };
    }
  }
  return worst;
}

export function recordFailure(buckets: string[], now = Date.now()): void {
  const stmt = getServerDb().prepare(
    "INSERT INTO server_login_attempts (bucket, attempted_at) VALUES (?, ?)"
  );
  const insertAll = getServerDb().transaction((list: string[]) => {
    for (const b of list) stmt.run(b, now);
  });
  insertAll(buckets);
}

/** Clears both buckets after a success, so one good login ends the lockout for
 *  the address that produced it. */
export function clearFailures(buckets: string[]): void {
  const stmt = getServerDb().prepare(
    "DELETE FROM server_login_attempts WHERE bucket = ?"
  );
  const clearAll = getServerDb().transaction((list: string[]) => {
    for (const b of list) stmt.run(b);
  });
  clearAll(buckets);
}

export function bucketsFor(remoteAddress: string, account: string | null): string[] {
  const buckets = [`ip:${remoteAddress}`];
  if (account) buckets.push(`acct:${account.trim().toLowerCase()}`);
  return buckets;
}
