import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { Strategy as FacebookStrategy } from "passport-facebook";
import type { ServerConfig } from "../config";
import { findIdentityById, type Identity, type Provider } from "./identities";

/**
 * Passport wiring.
 *
 * Only the *identification* half lives here — each strategy's verify callback
 * hands back a normalized profile and nothing else. Whether that person may use
 * this server is decided in `routes.ts`, after the callback, by
 * `authorizeIdentity()`. Splitting it that way is what makes the allowlist
 * impossible to skip: a strategy cannot "succeed" its way past it, because
 * succeeding does not log anyone in.
 */

/**
 * `state: true` on every strategy — the OAuth anti-CSRF nonce.
 *
 * passport-oauth2 then mints a nonce, stashes it in `req.session` on the way
 * out and requires it back on the callback. Without it the callback is a bare
 * GET, and `SameSite=Lax` sends the session cookie on exactly that kind of
 * top-level navigation — so an attacker who completes the provider leg
 * themselves and hands the resulting callback URL to a victim silently logs
 * that browser in **as the attacker**. Every rating, playlist and device the
 * victim touches afterwards lands in the wrong account.
 *
 * It goes on the constructor rather than on `passport.authenticate()` because
 * `@types/passport` declares `AuthenticateOptions.state` as a `string` (its
 * pre-nonce meaning, an opaque value echoed back), while the strategies'
 * own option types take the boolean. Setting it here also means the authorize
 * and callback legs cannot disagree, which is its own class of bug: a nonce
 * minted and never checked looks exactly like one that works.
 *
 * **The session must survive the round trip**, which is why the cookie is
 * `SameSite=Lax` and not `Strict` — see `http.ts`. Social login needs a real
 * provider to exercise, so this is manual-verification the way
 * `showDirectoryPicker()` is.
 */
export interface ProviderProfile {
  provider: Provider;
  subject: string;
  email: string | null;
  displayName: string | null;
  /** Whether the provider says it verified the address. An unverified email is
   *  never used for matching — only `subject` is — but it is worth recording. */
  emailVerified: boolean;
}

/** Only `passport.authenticate(..., { session: false })` is used, so the user
 *  object passport hands us is a `ProviderProfile`; the express session is
 *  written by our own code once the allowlist has agreed. */
export function configurePassport(config: ServerConfig): string[] {
  const enabled: string[] = [];

  passport.serializeUser((user, done) => {
    done(null, (user as Identity).id);
  });
  passport.deserializeUser((id: number, done) => {
    done(null, findIdentityById(id) ?? false);
  });

  const callbackFor = (provider: string): string | null =>
    config.publicUrl ? `${config.publicUrl}/api/auth/${provider}/callback` : null;

  if (config.oauth.google) {
    const callbackURL = callbackFor("google");
    if (!callbackURL) {
      console.warn(
        "[server] Google credentials are set but no public URL is configured — " +
          "Google refuses a callback URI that is not a stable registered host, " +
          "so the strategy is not enabled."
      );
    } else {
      passport.use(
        new GoogleStrategy(
          {
            clientID: config.oauth.google.clientId,
            clientSecret: config.oauth.google.clientSecret,
            callbackURL,
            scope: ["profile", "email"],
            state: true,
          },
          (_accessToken, _refreshToken, profile, done) => {
            const email = profile.emails?.[0];
            const p: ProviderProfile = {
              provider: "google",
              subject: profile.id,
              email: email?.value ?? null,
              displayName: profile.displayName ?? null,
              // passport-google-oauth20 exposes `verified` as a string.
              emailVerified:
                String((email as { verified?: unknown })?.verified ?? "") === "true",
            };
            done(null, p);
          }
        )
      );
      enabled.push("google");
    }
  }

  if (config.oauth.github) {
    const callbackURL = callbackFor("github");
    if (callbackURL) {
      passport.use(
        new GitHubStrategy(
          {
            clientID: config.oauth.github.clientId,
            clientSecret: config.oauth.github.clientSecret,
            callbackURL,
            scope: ["read:user", "user:email"],
            // `passport-github2`'s own `StrategyOptions` still declares
            // `state` as a `string` — the pre-nonce meaning. The strategy
            // extends passport-oauth2, which has taken the boolean and done
            // the session-backed nonce for years; Google's and Facebook's
            // types already say so. The cast is the type stub being behind,
            // not a behaviour we are forcing.
            state: true as unknown as string,
          },
          (
            _accessToken: string,
            _refreshToken: string,
            profile: {
              id: string;
              displayName?: string;
              username?: string;
              emails?: { value: string }[];
            },
            done: (err: unknown, user?: ProviderProfile) => void
          ) => {
            const p: ProviderProfile = {
              provider: "github",
              subject: String(profile.id),
              email: profile.emails?.[0]?.value ?? null,
              displayName: profile.displayName ?? profile.username ?? null,
              // GitHub's user:email scope returns the address it considers
              // primary and verified; it does not restate the flag per entry.
              emailVerified: Boolean(profile.emails?.[0]?.value),
            };
            done(null, p);
          }
        )
      );
      enabled.push("github");
    } else {
      console.warn(
        "[server] GitHub credentials are set but no public URL is configured."
      );
    }
  }

  if (config.oauth.facebook) {
    const callbackURL = callbackFor("facebook");
    if (callbackURL) {
      passport.use(
        new FacebookStrategy(
          {
            clientID: config.oauth.facebook.clientId,
            clientSecret: config.oauth.facebook.clientSecret,
            callbackURL,
            profileFields: ["id", "displayName", "emails"],
            state: true,
          },
          (
            _accessToken: string,
            _refreshToken: string,
            profile: {
              id: string;
              displayName?: string;
              emails?: { value: string }[];
            },
            done: (err: unknown, user?: ProviderProfile) => void
          ) => {
            const p: ProviderProfile = {
              provider: "facebook",
              subject: String(profile.id),
              email: profile.emails?.[0]?.value ?? null,
              displayName: profile.displayName ?? null,
              emailVerified: false,
            };
            done(null, p);
          }
        )
      );
      enabled.push("facebook");
    } else {
      console.warn(
        "[server] Facebook credentials are set but no public URL is configured."
      );
    }
  }

  return enabled;
}

/** Drops every registered strategy. A server restart re-registers them against
 *  whatever the config says now. */
export function resetPassport(): void {
  for (const name of ["google", "github", "facebook"]) {
    try {
      passport.unuse(name);
    } catch {
      // Not registered; nothing to undo.
    }
  }
}

export { passport };
