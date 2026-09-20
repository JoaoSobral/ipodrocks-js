import * as crypto from "crypto";

/**
 * Local password hashing with `node:crypto`'s scrypt.
 *
 * A dedicated hashing package would be the usual answer, but scrypt is in the
 * standard library, is memory-hard, and this is a single-household server —
 * adding argon2 would mean a native build in the container for no practical
 * gain.
 *
 * Format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. The parameters are stored with
 * the hash so they can be raised later without invalidating existing passwords.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** scrypt with N=16384, r=8 needs ~16 MiB; the default 32 MiB cap is enough,
 *  but state it so raising N later fails loudly rather than silently. */
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      keylen,
      { N, r: R, p: P, maxmem: MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString(
    "base64"
  )}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await new Promise<Buffer | null>((resolve) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      expected.length,
      { N: n, r, p, maxmem: MAXMEM },
      (err, out) => resolve(err ? null : out)
    );
  });
  if (!derived || derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Minimum policy. Deliberately length-only: a server whose whole point is to be
 * reachable from the internet is protected by the length of the secret, not by
 * whether it contains a punctuation mark.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(password: unknown): { error: string } | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > 1024) {
    // scrypt on an unbounded input is a free CPU-exhaustion vector.
    return { error: "Password is too long" };
  }
  return null;
}
