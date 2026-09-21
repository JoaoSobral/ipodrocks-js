import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Coarse flood limits for the HTTP surface.
 *
 * These are **not** the brute-force protection. That is `auth/rate-limit.ts`,
 * which counts *failed* logins into two SQLite-backed buckets — one per
 * address, one per account — and locks out for fifteen minutes. It survives a
 * restart, which an in-memory counter does not, and it is what actually stops
 * somebody guessing a password.
 *
 * What these add is the other half: a ceiling on *total* requests, failed or
 * not, so one client cannot pin the daemon by asking for legitimate things as
 * fast as it can. The two are complementary and neither replaces the other.
 *
 * Every ceiling here is set well above anything a person generates and well
 * below what a loop does. They are keyed on `req.ip`, which honours
 * `trust proxy` — and `http.ts` sets that only to configured proxy addresses,
 * so an unproxied deployment cannot be spoofed past them with an
 * `X-Forwarded-For`.
 */

const MINUTE = 60 * 1000;
const FIFTEEN_MINUTES = 15 * MINUTE;

/** Ceilings, exported so a test can pin them rather than re-typing them. */
export const AUTH_WINDOW_MS = FIFTEEN_MINUTES;
export const AUTH_LIMIT = 600;
export const IDENTITY_ADMIN_WINDOW_MS = FIFTEEN_MINUTES;
export const IDENTITY_ADMIN_LIMIT = 120;
export const API_WINDOW_MS = MINUTE;
export const API_LIMIT = 2000;

function limiter(opts: {
  windowMs: number;
  limit: number;
  message: string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: opts.message });
    },
  });
}

/**
 * Everything under `/api/auth`: status, local login, the owner claim, and both
 * legs of every OAuth provider.
 *
 * Generous, because `/api/auth/status` is what the login page renders itself
 * from and a household shares one address behind NAT. The tight per-account
 * ceiling that makes password guessing pointless lives in `auth/rate-limit.ts`;
 * this one only has to stop a flood.
 */
export function authRateLimiter(): RateLimitRequestHandler {
  return limiter({
    windowMs: AUTH_WINDOW_MS,
    limit: AUTH_LIMIT,
    message: "Too many requests. Try again later.",
  });
}

/**
 * The allowlist routes — `GET/POST/DELETE /api/auth/identities`.
 *
 * Owner-only and low-volume by nature: an owner admits a household, not a
 * datacentre. Tight enough that enumerating identity ids by id is not a thing
 * you can do quietly.
 */
export function identityAdminRateLimiter(): RateLimitRequestHandler {
  return limiter({
    windowMs: IDENTITY_ADMIN_WINDOW_MS,
    limit: IDENTITY_ADMIN_LIMIT,
    message: "Too many allowlist requests. Try again later.",
  });
}

/**
 * The control plane (`/api/invoke`) and media streaming (`/api/media`).
 *
 * A panel load fires dozens of channels and a seek fires a Range request per
 * jump, so the ceiling is per *minute* and high: thirty-odd requests a second,
 * sustained, is not a person using the app.
 */
export function apiRateLimiter(): RateLimitRequestHandler {
  return limiter({
    windowMs: API_WINDOW_MS,
    limit: API_LIMIT,
    message: "Too many requests. Slow down.",
  });
}

/**
 * The device data plane (`/api/device-io`).
 *
 * **Deliberately absent.** A sync is one request per file plus the RPCs around
 * it, so copying a twenty-thousand-track library is tens of thousands of
 * requests as fast as the wire allows — that is the feature working, and any
 * ceiling low enough to be protection is low enough to break it. The route is
 * behind `requireAuth`, and every token it accepts is one-shot, HMAC-signed
 * and addressed to the socket that attached the device, so an unauthenticated
 * flood does not reach it and an authenticated one is the user's own sync.
 *
 * Exported as a named no-op rather than left implicit so that a future reader
 * finds this reasoning instead of an oversight.
 */
export const deviceIoIsDeliberatelyUnlimited = true;
