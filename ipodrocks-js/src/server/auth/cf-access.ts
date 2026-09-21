import * as crypto from "crypto";

/**
 * Cloudflare Access JWT verification.
 *
 * When Access is in front of the tunnel it authenticates the user *before* the
 * request reaches us and stamps `Cf-Access-Jwt-Assertion` on it. Verifying that
 * assertion is what turns "we are behind Access" from an assumption into a
 * check: without it, anyone who learns the tunnel's origin hostname — or who is
 * on the same host — reaches the app directly and Access is decorative.
 *
 * Implemented against the team's JWKS with `node:crypto` rather than a JWT
 * library: the whole surface is one RS256/ES256 signature, an audience and an
 * expiry, and a verifier this small is easier to be sure of than a dependency.
 */

export interface CfAccessConfig {
  /** e.g. `yourteam.cloudflareaccess.com`, with or without the scheme. */
  teamDomain: string;
  /** The Application Audience (AUD) tag from the Access application. */
  audience: string;
}

export interface CfAccessClaims {
  sub: string;
  email?: string;
  aud: string[];
  exp: number;
  iat: number;
  iss: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
/** A key rotation must not mean an hour of rejected logins, but a token with an
 *  unknown `kid` is also the cheapest possible way to make us fetch on demand.
 *  So: refresh on a miss, at most once a minute. */
const JWKS_MISS_REFRESH_MS = 60 * 1000;

const SUPPORTED_ALGS = new Set(["RS256", "ES256"]);

let cache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;
let lastMissRefresh = 0;

export function teamJwksUrl(teamDomain: string): string {
  const host = teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}/cdn-cgi/access/certs`;
}

async function loadJwks(url: string, force: boolean): Promise<Jwk[]> {
  const now = Date.now();
  if (
    !force &&
    cache &&
    cache.url === url &&
    now - cache.fetchedAt < JWKS_TTL_MS
  ) {
    return cache.keys;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  cache = { url, keys, fetchedAt: now };
  return keys;
}

function b64uToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function keyObjectFor(jwk: Jwk): crypto.KeyObject {
  // `createPublicKey` accepts a JWK directly; the cast is only because this
  // file's `Jwk` is narrowed to the members Cloudflare actually sends.
  return crypto.createPublicKey({
    key: jwk as unknown as crypto.JsonWebKeyInput["key"],
    format: "jwk",
  });
}

/**
 * ES256 signatures in a JWT are the raw 64-byte `r||s` pair; `crypto.verify`
 * wants DER unless told otherwise. `dsaEncoding: "ieee-p1363"` says so.
 */
function verifySignature(
  alg: string,
  signingInput: string,
  signature: Buffer,
  key: crypto.KeyObject
): boolean {
  if (alg === "RS256") {
    return crypto.verify("sha256", Buffer.from(signingInput), key, signature);
  }
  return crypto.verify(
    "sha256",
    Buffer.from(signingInput),
    { key, dsaEncoding: "ieee-p1363" },
    signature
  );
}

/**
 * Returns the verified claims, or null. Never throws for a bad token — a
 * malformed assertion is a 403, not a 500.
 */
export async function verifyCfAccessJwt(
  token: string,
  config: CfAccessConfig
): Promise<CfAccessClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(b64uToBuf(headerB64).toString("utf-8")) as {
      alg?: string;
      kid?: string;
    };
    // `alg: "none"`, and any algorithm we did not opt into, is rejected before
    // a key is even looked up — the classic JWT confusion attack.
    if (!header.alg || !SUPPORTED_ALGS.has(header.alg) || !header.kid) return null;

    const url = teamJwksUrl(config.teamDomain);
    let keys = await loadJwks(url, false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk && Date.now() - lastMissRefresh > JWKS_MISS_REFRESH_MS) {
      lastMissRefresh = Date.now();
      keys = await loadJwks(url, true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) return null;

    const ok = verifySignature(
      header.alg,
      `${headerB64}.${payloadB64}`,
      b64uToBuf(sigB64),
      keyObjectFor(jwk)
    );
    if (!ok) return null;

    const payload = JSON.parse(b64uToBuf(payloadB64).toString("utf-8")) as {
      sub?: string;
      email?: string;
      aud?: string | string[];
      exp?: number;
      iat?: number;
      iss?: string;
    };
    const aud = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud
        ? [payload.aud]
        : [];
    if (!aud.includes(config.audience)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    // The issuer must be the team we configured, not merely *a* Cloudflare
    // team: an Access token minted for someone else's tenant is signed by
    // their JWKS, but a misconfigured `teamDomain` is how that check gets lost.
    const expectedIss = `https://${config.teamDomain
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")}`;
    if (payload.iss !== expectedIss) return null;
    if (!payload.sub) return null;

    return {
      sub: payload.sub,
      email: payload.email,
      aud,
      exp: payload.exp,
      iat: payload.iat ?? 0,
      iss: payload.iss,
    };
  } catch {
    return null;
  }
}

/** Test/restart hook — drops the cached JWKS. */
export function resetCfAccessCache(): void {
  cache = null;
  lastMissRefresh = 0;
}
