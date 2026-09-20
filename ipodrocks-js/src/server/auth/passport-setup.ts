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
