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
  allowProviderIdentity,
  approveAccessRequest,
  consumeClaimToken,
  countIdentities,
  addNewLocalAccount,
  dismissAccessRequest,
  listAccessRequests,
  listIdentitiesWithLinks,
  removeIdentity,
  removeLink,
} from "../../server/auth/identities";
import { isProvider } from "../../shared/auth-providers";
import {
  denyIfNotOwner,
  listServerSessions,
  revokeAllSessions,
  revokeSessionsForIdentity,
} from "../../server/auth/sessions";
import { hashPassword, validatePassword } from "../../server/auth/passwords";
import { resetLocalPassword } from "../../server/auth/password-reset";

/**
 * The Settings → Web Server card's channels.
 *
 * These are registered like every other domain, which means they are reachable
 * *over the web server itself* — that is intentional and is why
 * `server:setConfig` never restarts the listener implicitly: a remote client
 * changing the port would otherwise cut its own connection mid-request and
 * never learn whether the change took. The restart is an explicit second call.
 *
 * **Every channel here is owner-gated, and that is wider than the allowlist
 * rule below.** "Anyone on the allowlist is a full user of the app" is the
 * right default for the library, the devices and the sync; it is not the right
 * default for the listener itself. `setConfig` writes `host`, `port`,
 * `publicUrl`, `allowedOrigins`, `trustedProxies` and `tls` to prefs, and
 * `stop` + `start` is a full restart that re-reads all of them — so a guest
 * could move the server off loopback onto `0.0.0.0`, clear the TLS pair (which
 * also clears the session cookie's `Secure` flag, since `http.ts` derives it
 * from `config.tls`/`publicUrl`) and set `trustedProxies` so the rate limiter
 * believes any `X-Forwarded-For`. That is CLAUDE.md's own highest tier —
 * "anything that changes what the outside world can reach" — reached through a
 * channel instead of a Rocksy tool.
 *
 * `server:getStatus` is gated too: with the listener's shape no longer editable
 * by a guest, its bind address, port and TLS paths are the owner's business.
 */

/** One line, because the gate itself lives in `server/auth/sessions.ts` and is
 *  shared with Rocksy's `web_server_*` tools — see `denyIfNotOwner`. */
function requireOwner(ctx: HandlerContext): { error: string } | null {
  return denyIfNotOwner(ctx.sessionId);
}

export function registerServerHandlers(): void {
  bridgeHandle(
    "server:getStatus",
    safe("server:getStatus", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      const status = getServerStatus();
      return {
        ...status,
        // The claim token is a live credential and belongs on the machine
        // holding the database — the Settings card shows it so its owner does
        // not have to go reading the log. It is unreachable over the web today
        // (it is non-null only while the allowlist is empty, and an empty
        // allowlist means nobody is authenticated), but that is a property of
        // two other rules rather than of this one. Rocksy's `web_server_status`
        // already redacts it; this is the same answer from the same fact.
        claimToken: event.sessionId === undefined ? status.claimToken : null,
        prefs: getWebServerPrefs(),
      };
    })
  );

  bridgeHandle(
    "server:setConfig",
    safe("server:setConfig", async (event, prefs: WebServerPrefs) => {
      const denied = requireOwner(event);
      if (denied) return denied;
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
    safe("server:start", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      setWebServerPrefs({ enabled: true });
      return ensureServerStarted();
    })
  );

  bridgeHandle(
    "server:stop",
    safe("server:stop", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
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
      // rows go out as they are, each with its linked sign-in methods.
      return { identities: listIdentitiesWithLinks() };
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
        if (!isProvider(provider)) {
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
          const outcome = await addNewLocalAccount(subject, String(input.password));
          if ("error" in outcome) return outcome;
          return { ok: true, identity: outcome.identity };
        }

        // Never `isOwner` — `allowProviderIdentity()` has no way to say it.
        const outcome = allowProviderIdentity({
          provider,
          subject,
          email: typeof input?.email === "string" ? input.email : null,
          displayName:
            typeof input?.displayName === "string" ? input.displayName : null,
        });
        if ("error" in outcome) return outcome;
        return { ok: true, identity: outcome.identity };
      }
    )
  );

  /**
   * Sets a local account's password — the owner's reset for anyone, including
   * themselves. Every other session of that account is signed out; the
   * caller's own is kept so an owner resetting their own password over the web
   * does not lose the page they did it from.
   */
  bridgeHandle(
    "server:setPassword",
    safe(
      "server:setPassword",
      async (event, input: { identityId?: unknown; password?: unknown }) => {
        const denied = requireOwner(event);
        if (denied) return denied;
        const id = Number(input?.identityId);
        if (!Number.isInteger(id)) return { error: "Pass an identityId." };
        const result = await resetLocalPassword(id, input?.password, {
          keepSessionId: event.sessionId,
        });
        if ("error" in result) return result;
        return { ok: true, signedOut: result.signedOut };
      }
    )
  );

  /**
   * Creates the owner straight from the desktop window, for a server nobody
   * has claimed yet.
   *
   * **Electron IPC only.** The desktop window already reads the claim token
   * off `server:getStatus` (it is the machine holding the database), so this
   * grants nothing the claim form did not — it only spares the owner a trip
   * through a browser. A web caller is refused outright: over the web the
   * claim token *is* the proof, and this channel takes none. Ownership is
   * still granted exactly once, because the token is consumed here too.
   */
  bridgeHandle(
    "server:claimOwner",
    safe(
      "server:claimOwner",
      async (event, input: { username?: unknown; password?: unknown }) => {
        if (event.sessionId !== undefined) {
          return {
            error: "Claim the server from its login page, with the one-time claim token.",
          };
        }
        if (countIdentities() > 0) {
          return { error: "This server already has an owner." };
        }
        const name = typeof input?.username === "string" ? input.username.trim() : "";
        if (name.length < 2) return { error: "Username must be at least 2 characters." };
        const bad = validatePassword(input?.password);
        if (bad) return bad;
        // Hash first: the empty-allowlist check and the insert must not have
        // an await between them, or a browser claim landing in the gap makes
        // a second owner.
        const hash = await hashPassword(String(input.password));
        if (countIdentities() > 0) {
          return { error: "This server already has an owner." };
        }
        const identity = addIdentity({
          provider: "local",
          subject: name.toLowerCase(),
          displayName: name,
          isOwner: true,
          passwordHash: hash,
        });
        consumeClaimToken();
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

  /** Removes one linked sign-in method. The identity and its sessions stay:
   *  the person is still allowed in, just not by that route. A guest removes
   *  their own links over `DELETE /api/auth/links/:id`; this channel is the
   *  owner's view of everyone's. */
  bridgeHandle(
    "server:removeLink",
    safe("server:removeLink", async (event, linkId: number) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      const id = Number(linkId);
      if (!Number.isInteger(id)) return { error: "Bad link id." };
      return removeLink(id);
    })
  );

  // -------------------------------------------------------------------------
  // Access requests — refused provider logins, for the owner to admit
  // -------------------------------------------------------------------------

  bridgeHandle(
    "server:listAccessRequests",
    safe("server:listAccessRequests", async (event) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      return { requests: listAccessRequests() };
    })
  );

  bridgeHandle(
    "server:approveAccessRequest",
    safe("server:approveAccessRequest", async (event, requestId: number) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      const id = Number(requestId);
      if (!Number.isInteger(id)) return { error: "Bad request id." };
      const outcome = approveAccessRequest(id);
      if ("error" in outcome) return outcome;
      return { ok: true, identity: outcome.identity };
    })
  );

  bridgeHandle(
    "server:dismissAccessRequest",
    safe("server:dismissAccessRequest", async (event, requestId: number) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      const id = Number(requestId);
      if (!Number.isInteger(id)) return { error: "Bad request id." };
      return dismissAccessRequest(id);
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
