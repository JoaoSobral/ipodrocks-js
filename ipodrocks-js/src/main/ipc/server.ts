import { handle as bridgeHandle, type HandlerContext } from "../host/bridge";
import { safe } from "./common";
import { getWebServerPrefs, setWebServerPrefs, type WebServerPrefs } from "../utils/prefs";
import {
  ensureServerStarted,
  getServerStatus,
  stopServerIfRunning,
} from "../../server";
import {
  addIdentity,
  createLocalAccount,
  listIdentities,
  removeIdentity,
  type Provider,
} from "../../server/auth/identities";
import {
  denyIfNotOwner,
  listServerSessions,
  revokeAllSessions,
  revokeSessionsForIdentity,
} from "../../server/auth/sessions";
import { validatePassword } from "../../server/auth/passwords";

/**
 * The Settings → Web Server card's channels.
 *
 * These are registered like every other domain, which means they are reachable
 * *over the web server itself* — that is intentional and is why
 * `server:setConfig` never restarts the listener implicitly: a remote client
 * changing the port would otherwise cut its own connection mid-request and
 * never learn whether the change took. The restart is an explicit second call.
 *
 * The allowlist channels below are the exception to "reachable over the web is
 * fine", and `requireOwner()` is why — see the comment on it.
 */

/** One line, because the gate itself lives in `server/auth/sessions.ts` and is
 *  shared with Rocksy's `web_server_*` tools — see `denyIfNotOwner`. */
function requireOwner(ctx: HandlerContext): { error: string } | null {
  return denyIfNotOwner(ctx.sessionId);
}

export function registerServerHandlers(): void {
  bridgeHandle(
    "server:getStatus",
    safe("server:getStatus", async () => ({
      ...getServerStatus(),
      prefs: getWebServerPrefs(),
    }))
  );

  bridgeHandle(
    "server:setConfig",
    safe("server:setConfig", async (_event, prefs: WebServerPrefs) => {
      const next: WebServerPrefs = {};
      if (typeof prefs?.enabled === "boolean") next.enabled = prefs.enabled;
      if (typeof prefs?.host === "string") next.host = prefs.host.trim();
      if (typeof prefs?.port === "number" && prefs.port > 0 && prefs.port < 65536) {
        next.port = Math.floor(prefs.port);
      }
      if (typeof prefs?.publicUrl === "string") {
        next.publicUrl = prefs.publicUrl.trim();
      }
      if (Array.isArray(prefs?.trustedProxies)) {
        next.trustedProxies = prefs.trustedProxies.map(String);
      }
      if (Array.isArray(prefs?.allowedOrigins)) {
        next.allowedOrigins = prefs.allowedOrigins.map(String);
      }
      if (prefs?.tls === null || typeof prefs?.tls === "object") {
        next.tls = prefs.tls
          ? {
              certPath: String(prefs.tls.certPath ?? ""),
              keyPath: String(prefs.tls.keyPath ?? ""),
            }
          : null;
      }
      setWebServerPrefs(next);
      return { prefs: getWebServerPrefs() };
    })
  );

  bridgeHandle(
    "server:start",
    safe("server:start", async () => {
      setWebServerPrefs({ enabled: true });
      return ensureServerStarted();
    })
  );

  bridgeHandle(
    "server:stop",
    safe("server:stop", async () => {
      setWebServerPrefs({ enabled: false });
      return stopServerIfRunning();
    })
  );

  // -------------------------------------------------------------------------
  // The allowlist and the live sessions — owner only
  //
  // Phase 2 exposed these over HTTP (`/api/auth/identities`) and nowhere else,
  // which left Settings and Rocksy unable to answer "who can sign in to my
  // server?" — the single most common thing an owner wants after turning it on.
  // -------------------------------------------------------------------------

  bridgeHandle(
    "server:listIdentities",
    safe("server:listIdentities", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      // `Identity` carries no password hash — `toIdentity()` drops it — so the
      // rows go out as they are.
      return { identities: listIdentities() };
    })
  );

  bridgeHandle(
    "server:listSessions",
    safe("server:listSessions", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      return { sessions: listServerSessions() };
    })
  );

  bridgeHandle(
    "server:allowIdentity",
    safe(
      "server:allowIdentity",
      async (
        event,
        input: {
          provider?: unknown;
          subject?: unknown;
          email?: unknown;
          displayName?: unknown;
          password?: unknown;
        }
      ) => {
        const denied = requireOwner(event);
        if (denied) return denied;

        const provider = String(input?.provider ?? "");
        if (!["google", "github", "facebook", "local"].includes(provider)) {
          return { error: `Unknown provider "${provider}".` };
        }
        const subject = String(input?.subject ?? "").trim();
        if (!subject) {
          return {
            error:
              "A subject is required — the provider's own stable user id, or " +
              "the username for a local account.",
          };
        }

        if (provider === "local") {
          const bad = validatePassword(input?.password);
          if (bad) return bad;
          const identity = await createLocalAccount(subject, String(input.password));
          return { ok: true, identity };
        }

        // Never `isOwner`. Ownership is claimed once, with the one-time token,
        // and there is deliberately no second way to grant it.
        const identity = addIdentity({
          provider: provider as Provider,
          subject,
          email: typeof input?.email === "string" ? input.email : null,
          displayName:
            typeof input?.displayName === "string" ? input.displayName : null,
        });
        return { ok: true, identity };
      }
    )
  );

  bridgeHandle(
    "server:revokeIdentity",
    safe("server:revokeIdentity", async (event, identityId: number) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      const id = Number(identityId);
      if (!Number.isInteger(id)) return { error: "Bad identity id." };

      const outcome = removeIdentity(id);
      if ("error" in outcome) return outcome;

      // Hygiene, not security: `currentIdentity()` already resolves a deleted
      // identity to null, so the cookie stops working the moment the row goes.
      // The rows themselves would otherwise sit in the table until the store's
      // lazy TTL sweep reached them, and show up in `server:listSessions` as
      // anonymous logins nobody can account for. Done here *and* at the HTTP
      // route rather than inside `removeIdentity()`, which would make
      // identities.ts and sessions.ts import each other.
      const revoked = revokeSessionsForIdentity(id);
      return { ok: true, sessionsRevoked: revoked };
    })
  );

  bridgeHandle(
    "server:revokeSessions",
    safe(
      "server:revokeSessions",
      async (event, input: { identityId?: unknown; all?: unknown }) => {
        const denied = requireOwner(event);
        if (denied) return denied;

        if (input?.all === true) {
          // Including the caller's own. That is what "sign everyone out" means,
          // and a partial version of it is worse than useless when the reason
          // for asking is a suspected compromise.
          return { ok: true, revoked: revokeAllSessions(), signedOutCaller: true };
        }
        const id = Number(input?.identityId);
        if (!Number.isInteger(id)) {
          return { error: "Pass an identityId, or all: true." };
        }
        return { ok: true, revoked: revokeSessionsForIdentity(id) };
      }
    )
  );
}
