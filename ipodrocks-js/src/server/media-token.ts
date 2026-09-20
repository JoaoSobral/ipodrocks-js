import * as crypto from "crypto";

/**
 * Signed, expiring capability tokens for `/api/media/:token`.
 *
 * Stateless on purpose: the alternative is a server-side map that has to be
 * swept, survive a restart, and be shared if the server is ever run more than
 * once. An HMAC over the payload gives the same guarantee with no state.
 *
 * The session binding is the part that matters. `getPlayerTempDir()` is one
 * directory for the whole server and its filenames are 8 random bytes, so a
 * token that only said "this path" would let one logged-in user fetch another's
 * in-progress transcode by replaying a URL. A token minted for a session is
 * only honoured for that session. Tokens minted without one — album art, whose
 * path is validated on its own merits — are honoured for any authenticated
 * session, which is no more than that session could read anyway.
 */

export interface MediaTokenPayload {
  /** Absolute path on the server. */
  p: string;
  /** Session the token is bound to, if any. */
  s?: string;
  /** Expiry, unix seconds. */
  e: number;
}

const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

let signingKey: Buffer | null = null;

/** Rotated on every server start: a token cannot outlive the process that
 *  issued it, and nothing needs it to. */
export function resetMediaTokenKey(): void {
  signingKey = crypto.randomBytes(32);
}

function key(): Buffer {
  if (!signingKey) resetMediaTokenKey();
  return signingKey as Buffer;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", key()).update(body).digest("base64url");
}

export function issueMediaToken(
  filePath: string,
  sessionId: string | null,
  ttlSeconds = DEFAULT_TTL_SECONDS
): string {
  const payload: MediaTokenPayload = {
    p: filePath,
    e: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  if (sessionId) payload.s = sessionId;
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Returns the path, or null. The signature is checked before the payload is
 * parsed, so a forged token never reaches `JSON.parse`.
 */
export function verifyMediaToken(
  token: string,
  sessionId: string | null
): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = Buffer.from(sign(body));
  const presented = Buffer.from(mac);
  if (
    expected.length !== presented.length ||
    !crypto.timingSafeEqual(expected, presented)
  ) {
    return null;
  }

  let payload: MediaTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf-8")
    ) as MediaTokenPayload;
  } catch {
    return null;
  }

  if (typeof payload.p !== "string" || !payload.p) return null;
  if (typeof payload.e !== "number" || payload.e * 1000 < Date.now()) return null;
  if (payload.s && payload.s !== sessionId) return null;
  return payload.p;
}
