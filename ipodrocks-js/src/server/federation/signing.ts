import * as crypto from "crypto";
import { getSetting, setSetting } from "../db";

/**
 * Server-to-server request signing for library sharing.
 *
 * A peer never holds a reusable secret. Each server has one Ed25519 key pair,
 * the sharer binds the recipient's public key to a share at pairing time, and
 * every later request is signed over a canonical string — method, path, share
 * id, a timestamp and a nonce. A captured request is good for one use inside a
 * five-minute window, and a stolen database dump of the *sharer* yields
 * nothing that can sign.
 *
 * `node:crypto` only, for the reason `auth/cf-access.ts` gives: the surface is
 * one signature and three header checks, and a verifier this small is easier
 * to be sure of than a dependency. Mutual TLS is not an option — Cloudflare
 * Tunnel and Tailscale Funnel both terminate TLS before the request arrives.
 */

const PRIVATE_KEY_SETTING = "federation_private_key";
const PUBLIC_KEY_SETTING = "federation_public_key";

/** How far a request's `created` may sit from our clock, either way. */
export const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export const HDR_SHARE = "x-ipodrocks-share";
export const HDR_CREATED = "x-ipodrocks-created";
export const HDR_NONCE = "x-ipodrocks-nonce";
export const HDR_SIGNATURE = "x-ipodrocks-signature";

export interface ServerKeyPair {
  /** SPKI DER, base64url. What a peer stores and what a fingerprint is of. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

let cached: ServerKeyPair | null = null;

/** Forgets the cached pair. Server stop, and tests that swap data dirs. */
export function resetServerKeyPair(): void {
  cached = null;
  nonces.clear();
}

/**
 * This server's federation key pair, generated on first use and kept in
 * `server_settings` — the `0600` auth store, beside the session secret.
 */
export function getServerKeyPair(): ServerKeyPair {
  if (cached) return cached;
  const storedPriv = getSetting(PRIVATE_KEY_SETTING);
  const storedPub = getSetting(PUBLIC_KEY_SETTING);
  if (storedPriv && storedPub) {
    cached = {
      publicKey: storedPub,
      privateKey: crypto.createPrivateKey({
        key: Buffer.from(storedPriv, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
    };
    return cached;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  setSetting(PRIVATE_KEY_SETTING, priv);
  setSetting(PUBLIC_KEY_SETTING, pub);
  cached = { publicKey: pub, privateKey };
  return cached;
}

/**
 * Parses a peer-supplied public key, refusing anything that is not Ed25519.
 * Returns null rather than throwing: the input is remote.
 */
export function parsePeerPublicKey(raw: unknown): crypto.KeyObject | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(raw, "base64url"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/** Short, human-comparable fingerprint shown on both sides after pairing. */
export function keyFingerprint(publicKey: string): string {
  const hex = crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join(":");
}

/**
 * The bytes that are signed. Newline-joined, every field fixed-position, so no
 * field can smuggle content into another. `path` includes the query string.
 */
export function canonicalString(parts: {
  method: string;
  path: string;
  shareId: string;
  created: string;
  nonce: string;
}): string {
  return [
    "ipodrocks-federation-v1",
    parts.method.toUpperCase(),
    parts.path,
    parts.shareId,
    parts.created,
    parts.nonce,
  ].join("\n");
}

/** Headers a recipient sends with one request. */
export function signRequest(
  method: string,
  pathWithQuery: string,
  shareId: string,
  now = Date.now(),
  keyPair: ServerKeyPair = getServerKeyPair()
): Record<string, string> {
  const created = String(now);
  const nonce = crypto.randomBytes(16).toString("base64url");
  const sig = crypto.sign(
    null,
    Buffer.from(canonicalString({ method, path: pathWithQuery, shareId, created, nonce })),
    keyPair.privateKey
  );
  return {
    [HDR_SHARE]: shareId,
    [HDR_CREATED]: created,
    [HDR_NONCE]: nonce,
    [HDR_SIGNATURE]: sig.toString("base64url"),
  };
}

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

/**
 * Nonces seen inside the skew window. In memory on purpose: a restart forgets
 * them, but a replay across a restart still has to land inside the same
 * five-minute window, and persisting every request's nonce would put a write
 * on every Range request a stream makes.
 */
const nonces = new Map<string, number>();
const MAX_NONCES = 100_000;

function rememberNonce(key: string, now: number): boolean {
  if (nonces.has(key)) return false;
  if (nonces.size >= MAX_NONCES) {
    for (const [k, at] of nonces) {
      if (at < now - SIGNATURE_MAX_SKEW_MS) nonces.delete(k);
    }
    // Still full of live nonces: refuse rather than evict one that is still
    // replayable. A peer producing 100k requests in five minutes is a flood.
    if (nonces.size >= MAX_NONCES) return false;
  }
  nonces.set(key, now);
  return true;
}

export type SignatureVerdict =
  | { ok: true; shareId: string }
  | { ok: false; reason: "missing" | "skew" | "replay" | "bad-signature" | "unknown-share" };

/**
 * Verifies one request. `lookupKey` resolves the share id to the public key
 * bound at pairing time, or null for an unknown/revoked share.
 *
 * The nonce is consumed only *after* the signature verifies — otherwise an
 * attacker could burn a legitimate peer's nonces with forged requests.
 */
export function verifyRequest(
  req: { method: string; pathWithQuery: string; header(name: string): string | undefined },
  lookupKey: (shareId: string) => crypto.KeyObject | null,
  now = Date.now()
): SignatureVerdict {
  const shareId = req.header(HDR_SHARE);
  const created = req.header(HDR_CREATED);
  const nonce = req.header(HDR_NONCE);
  const signature = req.header(HDR_SIGNATURE);
  if (!shareId || !created || !nonce || !signature) return { ok: false, reason: "missing" };
  if (shareId.length > 64 || nonce.length > 64 || signature.length > 128) {
    return { ok: false, reason: "missing" };
  }
  if (!/^\d{1,16}$/.test(created)) return { ok: false, reason: "skew" };
  const createdMs = Number(created);
  if (Math.abs(now - createdMs) > SIGNATURE_MAX_SKEW_MS) return { ok: false, reason: "skew" };

  const key = lookupKey(shareId);
  if (!key) return { ok: false, reason: "unknown-share" };

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(
        canonicalString({
          method: req.method,
          path: req.pathWithQuery,
          shareId,
          created,
          nonce,
        })
      ),
      key,
      Buffer.from(signature, "base64url")
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad-signature" };
  if (!rememberNonce(`${shareId}:${nonce}`, now)) return { ok: false, reason: "replay" };
  return { ok: true, shareId };
}

// ---------------------------------------------------------------------------
// Response countersignature
// ---------------------------------------------------------------------------

export const HDR_RESPONSE_SIGNATURE = "x-ipodrocks-response-sig";

function responseString(shareId: string, nonce: string): string {
  return ["ipodrocks-federation-response-v1", shareId, nonce].join("\n");
}

/**
 * The sharer's countersignature over a request it authenticated. The nonce is
 * the recipient's own and fresh per request, so this cannot be replayed from
 * an earlier answer: it proves *this* response came from the key the
 * recipient pinned at pairing — which TLS alone does not, once a hostname is
 * re-pointed at another box with a valid certificate of its own.
 */
export function signResponse(
  shareId: string,
  nonce: string,
  keyPair: ServerKeyPair = getServerKeyPair()
): string {
  return crypto
    .sign(null, Buffer.from(responseString(shareId, nonce)), keyPair.privateKey)
    .toString("base64url");
}

export function verifyResponse(
  sharerKey: crypto.KeyObject,
  shareId: string,
  nonce: string,
  signature: string | null | undefined
): boolean {
  if (!signature || signature.length > 128) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(responseString(shareId, nonce)),
      sharerKey,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}
