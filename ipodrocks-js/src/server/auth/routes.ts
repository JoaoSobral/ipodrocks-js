import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServerConfig } from "../config";
import { passport, type ProviderProfile } from "./passport-setup";
import {
  authorizeIdentity,
  countIdentities,
  createLocalAccount,
  listIdentities,
  removeIdentity,
  setLocalPassword,
  verifyLocalLogin,
  findIdentityById,
  markLogin,
  type Identity,
} from "./identities";
import { validatePassword } from "./passwords";
import {
  bucketsFor,
  checkRateLimit,
  clearFailures,
  recordFailure,
} from "./rate-limit";
import { verifyCfAccessJwt } from "./cf-access";
import { revokeSessionsForIdentity } from "./sessions";

/**
 * Every route that creates, inspects or destroys a login.
 *
 * The shape to keep in mind: a provider callback *identifies*, and
 * `authorizeIdentity()` *admits*. Nothing here logs anyone in without going
 * through the second step, including the local password strategy — a local
 * account still has a row in the allowlist, so "is this person allowed" has one
 * answer and one place that gives it.
 */

declare module "express-session" {
  interface SessionData {
    identityId?: number;
    /** Claim token typed at the login form, carried across the OAuth redirect
     *  so the callback can present it. Cleared as soon as it is used. */
    pendingClaimToken?: string;
  }
}

export interface AuthDeps {
  config: ServerConfig;
  enabledProviders: string[];
}

/** The address a rate-limit bucket is keyed on. `req.ip` already honours
 *  `trust proxy`, which `http.ts` only sets for configured proxy addresses —
 *  so an unproxied deployment cannot be spoofed by an `X-Forwarded-For`. */
function remoteAddress(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function currentIdentity(req: Request): Identity | null {
  const id = req.session?.identityId;
  return typeof id === "number" ? findIdentityById(id) : null;
}

/**
 * The authenticated subject, or null.
 *
 * When Cloudflare Access is configured this is *also* gated on a valid
 * `Cf-Access-Jwt-Assertion`, so a request that reached the origin without going
 * through Access is rejected even if it carries a valid session cookie. That is
 * the whole point of verifying the assertion rather than trusting the tunnel.
 */
export async function authenticatedSubject(
  req: Request,
  config: ServerConfig
): Promise<string | null> {
  if (config.cloudflareAccess) {
    const assertion = req.headers["cf-access-jwt-assertion"];
    const token = Array.isArray(assertion) ? assertion[0] : assertion;
    if (!token) return null;
    const claims = await verifyCfAccessJwt(token, config.cloudflareAccess);
    if (!claims) return null;
  }
  const identity = currentIdentity(req);
  return identity ? `${identity.provider}:${identity.subject}` : null;
}

export function requireAuth(config: ServerConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void authenticatedSubject(req, config).then(
      (subject) => {
        if (!subject) {
          res.status(401).json({ error: "Not authenticated" });
          return;
        }
        next();
      },
      // A rejection here is a *failure to decide*, so it must answer, not fall
      // through. `verifyCfAccessJwt` swallows a bad token but not a JWKS fetch
      // that throws outside its try — and without this arm that request never
      // gets a response at all: the browser hangs on the spinner while the
      // socket is held open, which reads as "the server is down" rather than
      // as an auth problem. 401 is the honest answer: we could not establish
      // who this is.
      (err: unknown) => {
        console.error(
          `[server] authentication check failed — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        res.status(401).json({ error: "Not authenticated" });
      }
    );
  };
}

function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const identity = currentIdentity(req);
  if (!identity?.isOwner) {
    res.status(403).json({ error: "Owner only" });
    return;
  }
  next();
}

/** Regenerates the session id on every login. Without it, an attacker who can
 *  set a cookie before the victim logs in keeps a session that is now
 *  authenticated — session fixation, and it costs one call to avoid. */
function loginAs(req: Request, identity: Identity): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.identityId = identity.id;
      delete req.session.pendingClaimToken;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export function createAuthRouter(deps: AuthDeps): Router {
  const router = Router();
  const { config } = deps;

  // -------------------------------------------------------------------------
  // Status — what the login page renders itself from
  // -------------------------------------------------------------------------
  router.get("/status", (req, res) => {
    void (async () => {
      const identity = currentIdentity(req);
      // Same reasoning as `requireAuth`: a throw here would leave the login
      // page waiting forever for the JSON it renders itself from.
      const subject = await authenticatedSubject(req, config).catch(() => null);
      res.json({
        authenticated: subject !== null,
        needsOwnerClaim: countIdentities() === 0,
        providers: deps.enabledProviders,
        localEnabled: true,
        user: identity
          ? {
              provider: identity.provider,
              displayName: identity.displayName,
              email: identity.email,
              isOwner: identity.isOwner,
            }
          : null,
      });
    })();
  });

  // -------------------------------------------------------------------------
  // Local password login
  // -------------------------------------------------------------------------
  router.post("/local/login", (req, res) => {
    void (async () => {
      const { username, password } = (req.body ?? {}) as Record<string, unknown>;
      const buckets = bucketsFor(
        remoteAddress(req),
        typeof username === "string" ? username : null
      );
      const verdict = checkRateLimit(buckets);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({
          error: "Too many failed attempts. Try again later.",
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
        return;
      }

      const identity = await verifyLocalLogin(
        String(username ?? ""),
        String(password ?? "")
      );
      if (!identity) {
        recordFailure(buckets);
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      clearFailures(buckets);
      markLogin(identity.id);
      await loginAs(req, identity);
      res.json({ ok: true });
    })();
  });

  /**
   * First-run owner claim, for the local strategy.
   *
   * Only reachable while the allowlist is empty, and only with the token
   * printed to the server log. It creates the account *and* logs in, so a fresh
   * container is usable without any provider configured at all — which is what
   * makes a LAN install work, since Google will not accept a callback URI for
   * one.
   */
  router.post("/local/claim", (req, res) => {
    void (async () => {
      const { username, password, claimToken } = (req.body ?? {}) as Record<
        string,
        unknown
      >;
      const buckets = bucketsFor(remoteAddress(req), "claim");
      const verdict = checkRateLimit(buckets);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({ error: "Too many attempts. Try again later." });
        return;
      }
      if (countIdentities() > 0) {
        res.status(409).json({ error: "This server already has an owner." });
        return;
      }
      const name = String(username ?? "").trim();
      if (name.length < 2) {
        res.status(400).json({ error: "Username must be at least 2 characters" });
        return;
      }
      const bad = validatePassword(password);
      if (bad) {
        res.status(400).json(bad);
        return;
      }
      // Routed through the same gate as every other provider so the claim token
      // is checked in exactly one place.
      const verdict2 = authorizeIdentity({
        provider: "local",
        subject: name.toLowerCase(),
        displayName: name,
        claimToken,
      });
      if ("error" in verdict2) {
        recordFailure(buckets);
        res.status(403).json({ error: verdict2.error });
        return;
      }
      await setLocalPassword(verdict2.identity.id, String(password));
      clearFailures(buckets);
      await loginAs(req, verdict2.identity);
      res.json({ ok: true });
    })();
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("ipodrocks.sid");
      res.json({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // OAuth providers
  // -------------------------------------------------------------------------
  for (const provider of deps.enabledProviders) {
    router.get(`/${provider}`, (req, res, next) => {
      // A claim token typed at the login form has to survive the round trip to
      // the provider and back. It goes in the session rather than the `state`
      // parameter, which is echoed through the provider's logs.
      const token = req.query.claimToken;
      if (typeof token === "string" && token) req.session.pendingClaimToken = token;
      // The anti-CSRF nonce is configured on each Strategy (`state: true` in
      // `passport-setup.ts`), not here — see the note there.
      passport.authenticate(provider, { session: false })(req, res, next);
    });

    router.get(`/${provider}/callback`, (req, res, next) => {
      const buckets = bucketsFor(remoteAddress(req), `oauth:${provider}`);
      const verdict = checkRateLimit(buckets);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).type("text/plain").send("Too many attempts. Try again later.");
        return;
      }
      passport.authenticate(
        provider,
        { session: false },
        (err: unknown, profile: ProviderProfile | false) => {
          void (async () => {
            if (err || !profile) {
              recordFailure(buckets);
              res.redirect("/?auth=provider_failed");
              return;
            }
            const claimToken = req.session.pendingClaimToken;
            // A successful provider login is not an admission. This is the
            // only thing standing between "anyone with a Google account" and
            // the library.
            const outcome = authorizeIdentity({
              provider: profile.provider,
              subject: profile.subject,
              email: profile.emailVerified ? profile.email : null,
              displayName: profile.displayName,
              claimToken,
            });
            if ("error" in outcome) {
              recordFailure(buckets);
              delete req.session.pendingClaimToken;
              res.redirect("/?auth=not_allowed");
              return;
            }
            clearFailures(buckets);
            await loginAs(req, outcome.identity);
            res.redirect("/");
          })();
        }
      )(req, res, next);
    });
  }

  // -------------------------------------------------------------------------
  // Allowlist management — owner only
  // -------------------------------------------------------------------------
  router.get("/identities", requireAuth(config), requireOwner, (_req, res) => {
    res.json({ identities: listIdentities() });
  });

  router.post("/identities", requireAuth(config), requireOwner, (req, res) => {
    void (async () => {
      const { provider, subject, email, displayName, password } = (req.body ??
        {}) as Record<string, unknown>;
      const p = String(provider ?? "");
      if (!["google", "github", "facebook", "local"].includes(p)) {
        res.status(400).json({ error: "Unknown provider" });
        return;
      }
      const s = String(subject ?? "").trim();
      if (!s) {
        res.status(400).json({ error: "Subject is required" });
        return;
      }
      if (p === "local") {
        const bad = validatePassword(password);
        if (bad) {
          res.status(400).json(bad);
          return;
        }
        const identity = await createLocalAccount(s, String(password));
        res.json({ identity });
        return;
      }
      const { addIdentity } = await import("./identities");
      const identity = addIdentity({
        provider: p as Identity["provider"],
        subject: s,
        email: typeof email === "string" ? email : null,
        displayName: typeof displayName === "string" ? displayName : null,
      });
      res.json({ identity });
    })();
  });

  router.delete("/identities/:id", requireAuth(config), requireOwner, (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Bad id" });
      return;
    }
    const outcome = removeIdentity(id);
    if ("error" in outcome) {
      res.status(400).json(outcome);
      return;
    }
    // Hygiene rather than security — `currentIdentity()` already resolves a
    // deleted identity to null — but an orphaned row would otherwise linger
    // until the store's lazy TTL sweep and list as a login nobody can account
    // for. Kept at both call sites rather than inside `removeIdentity()`, which
    // would make identities.ts and sessions.ts import each other.
    const sessionsRevoked = revokeSessionsForIdentity(id);
    res.json({ ok: true, sessionsRevoked });
  });

  return router;
}
