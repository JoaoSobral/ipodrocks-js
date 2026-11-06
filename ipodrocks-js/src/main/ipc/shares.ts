import { handle as bridgeHandle, type HandlerContext } from "../host/bridge";
import { getLibraryDb, safe } from "./common";
import { logActivity } from "../activity/activity-logger";
import { getServerStatus } from "../../server";
import { denyIfNotOwner as denyIfNotOwnerBase } from "../../server/auth/sessions";
import {
  createShare,
  deleteShare,
  getShare,
  listShares,
  revokeShare,
  updateShare,
  type LibraryShare,
  type ShareSettingsInput,
} from "../../server/federation/shares";

const OWNER_ONLY_MESSAGE = "Only the server's owner can share the library.";

function denyIfNotOwner(sessionId: string | undefined): { error: string } | null {
  return denyIfNotOwnerBase(sessionId, OWNER_ONLY_MESSAGE);
}

/**
 * Settings → Sharing: the sharer's side of library sharing.
 *
 * **Owner-only, every channel.** A share hands part of the library to another
 * server, which is CLAUDE.md's "changes what the outside world can reach" —
 * the same reason `server:*` is gated. A guest is a full user of the app, not
 * of its front door.
 *
 * Shares need the web server: the peer reaches us at `/api/federation`, so a
 * share minted while it is off would hand out an invite nothing can redeem.
 * Rocksy's `share_*` tools call the same functions below.
 */

export function shareInviteLink(shareId: string, code: string): string | null {
  const status = getServerStatus();
  const base = status.publicUrl ?? status.url;
  if (!base) return null;
  // The secret rides in the fragment, so it never reaches a proxy log, a
  // tunnel's request log, or our own access log when the link is opened.
  return `${base.replace(/\/+$/, "")}/#share=${shareId}.${code}`;
}

function requireServer(): { error: string } | null {
  return getServerStatus().running
    ? null
    : { error: "Library sharing needs the web server. Turn it on in Settings → Web Server." };
}

export function createShareFor(
  ctx: { sessionId?: string },
  input: ShareSettingsInput
): { share: LibraryShare; inviteLink: string } | { error: string } {
  const denied = denyIfNotOwner(ctx.sessionId) ?? requireServer();
  if (denied) return denied;
  const created = createShare(input);
  if ("error" in created) return created;
  const inviteLink = shareInviteLink(created.share.id, created.inviteCode);
  if (!inviteLink) {
    deleteShare(created.share.id);
    return { error: "The web server has no address to put in the invite." };
  }
  logActivity(getLibraryDb(), "library_share_created", created.share.label);
  return { share: created.share, inviteLink };
}

export function revokeShareFor(
  ctx: { sessionId?: string },
  id: unknown
): { ok: true } | { error: string } {
  const denied = denyIfNotOwner(ctx.sessionId);
  if (denied) return denied;
  const share = typeof id === "string" ? getShare(id) : null;
  const result = revokeShare(id);
  if ("ok" in result && share) {
    logActivity(getLibraryDb(), "library_share_revoked", share.label);
  }
  return result;
}

export function listSharesFor(
  ctx: { sessionId?: string }
): { shares: LibraryShare[] } | { error: string } {
  const denied = denyIfNotOwner(ctx.sessionId);
  if (denied) return denied;
  return { shares: listShares() };
}

export function registerShareHandlers(): void {
  bridgeHandle(
    "share:list",
    safe("share:list", async (event: HandlerContext) => listSharesFor(event))
  );

  bridgeHandle(
    "share:create",
    safe("share:create", async (event: HandlerContext, input: ShareSettingsInput) =>
      createShareFor(event, input ?? {})
    )
  );

  bridgeHandle(
    "share:update",
    safe("share:update", async (event: HandlerContext, id: unknown, input: ShareSettingsInput) => {
      const denied = denyIfNotOwner(event.sessionId);
      if (denied) return denied;
      const result = updateShare(id, input ?? {});
      return "error" in result ? result : { share: result };
    })
  );

  bridgeHandle(
    "share:revoke",
    safe("share:revoke", async (event: HandlerContext, id: unknown) => revokeShareFor(event, id))
  );

  bridgeHandle(
    "share:delete",
    safe("share:delete", async (event: HandlerContext, id: unknown) => {
      const denied = denyIfNotOwner(event.sessionId);
      if (denied) return denied;
      return deleteShare(id);
    })
  );
}
