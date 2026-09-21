import type { NextFunction, Request, Response } from "express";
import { originAllowed } from "./events";

/**
 * Cross-origin refusal for state-changing API requests.
 *
 * The session cookie is `SameSite=Lax`, which already withholds it from a
 * cross-site POST — that is the primary protection and it has to stay, because
 * it is the only one that works before a single line of application code runs.
 * This is the second opinion, and it is the same rule the WebSocket upgrade in
 * `events.ts` has always enforced (`originAllowed()` is literally that
 * function): a request that announces an origin we do not serve is refused,
 * whatever the cookie jar decided.
 *
 * Two deliberate asymmetries with the WebSocket check:
 *
 * - **An absent `Origin` is admitted here, and refused there.** A browser sends
 *   `Origin` on every state-changing request; a request without one is not
 *   coming from a page, so there is no third party to forge it. Refusing it
 *   would lock out `curl`, the e2e harness and anyone driving the API from a
 *   script, and would buy nothing — CSRF needs a browser. The WebSocket can
 *   afford the stricter rule because its only real client *is* a browser.
 * - **Safe methods are exempt.** `GET /api/auth/<provider>/callback` is a
 *   top-level navigation the provider performs; it arrives cross-site by
 *   construction, and refusing it would break every social login. Nothing
 *   reachable by GET changes state.
 *
 * `Sec-Fetch-Site` is consulted when the browser sends it, because it is the
 * one header a page cannot set. `same-origin` and `none` (a user-initiated
 * navigation) pass; `same-site` and `cross-site` do not — a sibling subdomain
 * is not us, and on a LAN install it is quite possibly somebody else's box.
 */
export type OriginVerdict =
  | "safe-method"
  | "same-origin"
  | "no-origin"
  | "cross-site";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function judgeRequestOrigin(opts: {
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  allowedOrigins: string[];
}): OriginVerdict {
  if (SAFE_METHODS.has(opts.method.toUpperCase())) return "safe-method";

  // Checked before `Origin`, because a page cannot forge it and a proxy is far
  // less likely to rewrite it.
  if (opts.secFetchSite !== undefined) {
    if (opts.secFetchSite !== "same-origin" && opts.secFetchSite !== "none") {
      return "cross-site";
    }
  }

  if (opts.origin === undefined || opts.origin === "") {
    return opts.secFetchSite === undefined ? "no-origin" : "same-origin";
  }
  // The literal string `null` is what a sandboxed iframe or a `data:` document
  // sends. It is a present header, not an absent one, and it is never us — so
  // it falls through the allowlist and is refused.
  return originAllowed(opts.origin, opts.allowedOrigins) ? "same-origin" : "cross-site";
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Express middleware form. Mount on `/api` before any route that mutates. */
export function requireSameOrigin(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = judgeRequestOrigin({
      method: req.method,
      origin: headerValue(req, "origin"),
      secFetchSite: headerValue(req, "sec-fetch-site"),
      allowedOrigins,
    });
    if (verdict === "cross-site") {
      res.status(403).json({ error: "Cross-origin request refused" });
      return;
    }
    next();
  };
}
