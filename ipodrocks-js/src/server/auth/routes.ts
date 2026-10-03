import { Router, type Request, type Response, type NextFunction } from "express";
import type { ServerConfig } from "../config";
import { passport, type ProviderProfile } from "./passport-setup";
import {
  addLink,
  allowProviderIdentity,
  approveAccessRequest,
  authorizeIdentity,
  countIdentities,
  createLocalAccount,
  dismissAccessRequest,
  findLinkById,
  listAccessRequests,
  listIdentitiesWithLinks,
  listLinks,
  removeIdentity,
  removeLink,
  setLocalPassword,
  verifyLocalLogin,
  findIdentityById,
  markLogin,
  type Identity,
} from "./identities";
import { validatePassword } from "./passwords";
import { isOAuthProvider, isProvider, type OAuthProvider } from "../../shared/auth-providers";
import {
  bucketsFor,
  checkRateLimit,
  clearFailures,
  recordFailure,
  reserveAttempt,
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
    /** Set by `POST /link/:provider`: the next callback for `provider` attaches
     *  the account to `identityId` instead of logging in. Honoured only while
     *  the session is still that identity and before `expiresAt`. */
    pendingLink?: { identityId: number; provider: OAuthProvider; expiresAt: number };
  }
}

/** How long a started link waits for the provider to come back. */
export const PENDING_LINK_TTL_MS = 10 * 60 * 1000;

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
              id: identity.id,
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
      // The bucket and the account lookup must be keyed on the *same* value.
      // Reading the bucket off `typeof username === "string"` while the lookup
      // coerced with `String(username)` let a JSON array -- ["owner"] -- name a
      // real account while creating no per-account bucket for it, so the
      // ten-attempt ceiling never applied to it.
      if (typeof username !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "Invalid username or password" });
        return;
      }
      const buckets = bucketsFor(remoteAddress(req), username);
      // Reserve rather than check: the scrypt derivation below yields, and a
      // check whose write lands afterwards lets a whole burst through at once.
      const verdict = reserveAttempt(buckets);
      if (!verdict.allowed) {
        res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
        res.status(429).json({
          error: "Too many failed attempts. Try again later.",
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
        return;
      }

      const identity = await verifyLocalLogin(username, password);
      if (!identity) {
        // Already recorded by reserveAttempt().
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
      // **Keyed on the caller, never on the provider.** This used to add
      // `acct:oauth:<provider>` — one constant bucket shared by every user of
      // that provider, given the per-*account* ceiling of ten. Ten bare GETs
      // from anyone then answered every Google login from every address with a
      // 429, and since the refusal comes before passport, no successful login
      // could ever reach `clearFailures()` to release it. A failed callback
      // guesses nothing — the provider did the authenticating — so there is no
      // account to protect here, only the address to slow down.
      //
      // The one secret a callback *can* guess is the claim token carried from
      // the login form, and that is charged to `acct:claim` exactly like
      // `/local/claim`, so the provider route is not a second, looser way in.
      const buckets = bucketsFor(
        remoteAddress(req),
        typeof req.session?.pendingClaimToken === "string" ? "claim" : null
      );
      // Same check-then-act shape as /local/login: passport.authenticate's
      // callback is asynchronous, so a check whose write lands afterwards lets
      // a burst through. Reserve up front; clearFailures() below erases it.
      const verdict = reserveAttempt(buckets);
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
              // Already recorded by reserveAttempt().
              res.redirect("/?auth=provider_failed");
              return;
            }
            // A link started by `POST /link/:provider`. Consumed whatever
            // happens next, so a stale one cannot turn a later login into a
            // link. It is honoured only for the provider it was started for
            // and only while the session is still the identity that started
            // it — `currentIdentity()` re-reads the row, so a revoked identity
            // or a session that has since changed hands falls through to an
            // ordinary login.
            //
            // **The `state: true` nonce is what makes this safe.** Without it,
            // an attacker could complete the provider leg with their *own*
            // account and hand the signed-in victim the callback URL: this
            // branch would then attach the attacker's account to the victim's
            // identity, and the attacker could sign in as the victim from then
            // on. The nonce lives in the session that started the flow, so a
            // callback minted in any other browser fails in passport before it
            // gets here.
            const pendingLink = req.session.pendingLink;
            delete req.session.pendingLink;
            const linker = currentIdentity(req);
            if (
              pendingLink &&
              pendingLink.provider === provider &&
              pendingLink.expiresAt > Date.now() &&
              linker !== null &&
              linker.id === pendingLink.identityId
            ) {
              const linked = addLink({
                identityId: linker.id,
                provider: pendingLink.provider,
                subject: profile.subject,
                email: profile.emailVerified ? profile.email : null,
                displayName: profile.displayName,
              });
              clearFailures(buckets);
              // No `loginAs()`: the session already is this identity, and
              // regenerating it would only log the user out of other tabs.
              req.session.save(() => {
                res.redirect(
                  "error" in linked
                    ? `/?auth=link_failed&reason=${linked.error}`
                    : "/?auth=linked"
                );
              });
              return;
            }

            const claimToken = req.session.pendingClaimToken;
            // A successful provider login is not an admission. This is the
            // only thing standing between "anyone with a Google account" and
            // the library.
            const outcome = authorizeIdentity({
              provider: profile.provider,
              subject: profile.subject,
              email: profile.email,
              emailVerified: profile.emailVerified,
              displayName: profile.displayName,
              claimToken,
            });
            if ("error" in outcome) {
              // Already recorded by reserveAttempt().
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
  // Linked sign-in methods — any signed-in user, for their own identity
  // -------------------------------------------------------------------------

  /**
   * Starts attaching a provider account to the caller's identity.
   *
   * A POST, so `origin-guard.ts` refuses it from any page we do not serve —
   * a cross-site page cannot start a link in the owner's browser. It only marks
   * the session; the browser then navigates to the ordinary
   * `/api/auth/<provider>` start, and the callback finishes the link.
   */
  router.post("/link/:provider", requireAuth(config), (req, res) => {
    const provider = String(req.params.provider);
    if (!isOAuthProvider(provider) || !deps.enabledProviders.includes(provider)) {
      res.status(404).json({ error: "That sign-in provider is not configured." });
      return;
    }
    const identity = currentIdentity(req);
    if (!identity) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    req.session.pendingLink = {
      identityId: identity.id,
      provider,
      expiresAt: Date.now() + PENDING_LINK_TTL_MS,
    };
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "Could not start linking." });
        return;
      }
      res.json({ url: `/api/auth/${provider}` });
    });
  });

  router.get("/links", requireAuth(config), (req, res) => {
    const identity = currentIdentity(req);
    res.json({ links: identity ? listLinks(identity.id) : [] });
  });

  /** The caller's own link, or any link for the owner. Sessions are left
   *  alone: they belong to the identity, which is still allowed in. */
  router.delete("/links/:id", requireAuth(config), (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    const identity = currentIdentity(req);
    const link = Number.isFinite(id) ? findLinkById(id) : null;
    if (!link || !identity) {
      res.status(404).json({ error: "No such sign-in method" });
      return;
    }
    if (link.identityId !== identity.id && !identity.isOwner) {
      res.status(403).json({ error: "That sign-in method belongs to someone else." });
      return;
    }
    res.json(removeLink(link.id));
  });

  // -------------------------------------------------------------------------
  // Access requests — owner only
  // -------------------------------------------------------------------------
  router.get("/access-requests", requireAuth(config), requireOwner, (_req, res) => {
    res.json({ requests: listAccessRequests() });
  });

  router.post(
    "/access-requests/:id/approve",
    requireAuth(config),
    requireOwner,
    (req, res) => {
      const id = Number.parseInt(String(req.params.id), 10);
      const outcome = Number.isFinite(id)
        ? approveAccessRequest(id)
        : { error: "Bad id" };
      if ("error" in outcome) {
        res.status(400).json(outcome);
        return;
      }
      res.json(outcome);
    }
  );

  router.delete("/access-requests/:id", requireAuth(config), requireOwner, (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    const outcome = Number.isFinite(id) ? dismissAccessRequest(id) : { error: "Bad id" };
    res.status("error" in outcome ? 400 : 200).json(outcome);
  });

  // -------------------------------------------------------------------------
  // Allowlist management — owner only
  // -------------------------------------------------------------------------
  router.get("/identities", requireAuth(config), requireOwner, (_req, res) => {
    res.json({ identities: listIdentitiesWithLinks() });
  });

  router.post("/identities", requireAuth(config), requireOwner, (req, res) => {
    void (async () => {
      const { provider, subject, email, displayName, password } = (req.body ??
        {}) as Record<string, unknown>;
      const p = String(provider ?? "");
      if (!isProvider(p)) {
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
      const outcome = allowProviderIdentity({
        provider: p,
        subject: s,
        email: typeof email === "string" ? email : null,
        displayName: typeof displayName === "string" ? displayName : null,
      });
      if ("error" in outcome) {
        res.status(409).json(outcome);
        return;
      }
      res.json(outcome);
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
