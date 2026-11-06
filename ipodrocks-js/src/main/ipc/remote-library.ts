import * as os from "os";
import { handle as bridgeHandle, type HandlerContext } from "../host/bridge";
import { getLibraryDb, safe } from "./common";
import { runLibraryScan } from "./library";
import { getServerStatus } from "../../server";
import { denyIfNotOwner as denyIfNotOwnerBase } from "../../server/auth/sessions";
import { remoteMediaUrl } from "../../server/remote-media-route";
import { pairWithInvite, PeerError } from "../remote-library/peer-client";
import {
  cleanCfCredentials,
  deleteRemoteLibraryRow,
  getRemoteLibraryRow,
  insertRemoteLibrary,
  listRemoteLibraries,
  listRemoteTracks,
  remoteTrackById,
  setPeerSecrets,
  type RemoteLibrary,
} from "../remote-library/store";
import { refreshRemoteLibrary } from "../remote-library/catalog-sync";
import { evictOffline, keepOffline, purgeRemoteCache, setCacheScanRunner } from "../remote-library/cache";
import { cleanLabel } from "../../server/federation/shares";

/**
 * Library → Remote libraries: the recipient's side of library sharing.
 *
 * Who may do what, decided here once and shared with Rocksy's
 * `remote_library_*` tools through the `…For(ctx)` functions:
 *
 * - **Owner only:** adding a remote library and removing one. Adding makes
 *   this server connect, on a timer, to a host that came in through a link —
 *   CLAUDE.md's "changes what the outside world can reach".
 * - **Any signed-in user:** browsing, refreshing, streaming, and keeping
 *   tracks offline or dropping those copies. A remote library is part of the
 *   library, and everyone on the allowlist is a full user of that.
 *
 * Everything needs the web server: the peer client signs with the server's
 * federation key, and playback goes through `/api/remote-media`. The desktop
 * window never shows this feature.
 */

const OWNER_ONLY_MESSAGE = "Only the server's owner can add or remove remote libraries.";

function denyIfNotOwner(sessionId: string | undefined): { error: string } | null {
  return denyIfNotOwnerBase(sessionId, OWNER_ONLY_MESSAGE);
}

function requireServer(): { error: string } | null {
  return getServerStatus().running
    ? null
    : { error: "Remote libraries need the web server. Turn it on in Settings → Web Server." };
}

function ids(raw: unknown): number[] {
  return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n)) : [];
}

export interface AddRemoteLibraryInput {
  inviteLink?: unknown;
  name?: unknown;
  lan?: unknown;
  cfClientId?: unknown;
  cfClientSecret?: unknown;
}

export async function addRemoteLibraryFor(
  ctx: { sessionId?: string },
  input: AddRemoteLibraryInput
): Promise<{ library: RemoteLibrary } | { error: string }> {
  const denied = denyIfNotOwner(ctx.sessionId) ?? requireServer();
  if (denied) return denied;
  const cf = cleanCfCredentials(input.cfClientId, input.cfClientSecret);
  if (cf && "error" in cf) return cf;
  const lan = input.lan === true;
  let paired;
  try {
    paired = await pairWithInvite(input.inviteLink, {
      lan,
      peerName: os.hostname().slice(0, 80),
      cf,
    });
  } catch (err) {
    return { error: err instanceof PeerError || err instanceof Error ? err.message : String(err) };
  }
  const db = getLibraryDb();
  const name = cleanLabel(input.name, 80) || cleanLabel(paired.label, 80) || "Shared library";
  const id = insertRemoteLibrary(db, { name, target: paired.target, allowDownload: paired.allowDownload });
  if (typeof id !== "number") return id;
  setPeerSecrets(id, cf);
  await refreshRemoteLibrary(db, id);
  return { library: listRemoteLibraries(db).find((l) => l.id === id)! };
}

export async function removeRemoteLibraryFor(
  ctx: { sessionId?: string },
  id: unknown
): Promise<{ ok: true } | { error: string }> {
  const denied = denyIfNotOwner(ctx.sessionId);
  if (denied) return denied;
  const db = getLibraryDb();
  const row = getRemoteLibraryRow(db, id);
  if (!row) return { error: "Remote library not found." };
  await purgeRemoteCache(db, row.id);
  deleteRemoteLibraryRow(db, row.id);
  return { ok: true };
}

export function listRemoteLibrariesFor(): { libraries: RemoteLibrary[] } | { error: string } {
  const denied = requireServer();
  if (denied) return denied;
  return { libraries: listRemoteLibraries(getLibraryDb()) };
}

export async function refreshRemoteLibraryFor(id: unknown) {
  const denied = requireServer();
  if (denied) return denied;
  const db = getLibraryDb();
  const row = getRemoteLibraryRow(db, id);
  if (!row) return { error: "Remote library not found." };
  return refreshRemoteLibrary(db, row.id);
}

export async function keepOfflineFor(id: unknown, trackIds: unknown) {
  const denied = requireServer();
  if (denied) return denied;
  if (typeof id !== "number") return { error: "Remote library not found." };
  return keepOffline(getLibraryDb(), id, ids(trackIds));
}

export async function evictOfflineFor(id: unknown, trackIds: unknown) {
  if (typeof id !== "number") return { error: "Remote library not found." };
  return evictOffline(getLibraryDb(), id, ids(trackIds));
}

export function registerRemoteLibraryHandlers(): void {
  setCacheScanRunner((folderPath, name) =>
    runLibraryScan([{ name, path: folderPath, contentType: "music" }])
  );

  bridgeHandle("remote:list", safe("remote:list", async () => listRemoteLibrariesFor()));

  bridgeHandle(
    "remote:add",
    safe("remote:add", async (event: HandlerContext, input: AddRemoteLibraryInput) =>
      addRemoteLibraryFor(event, input ?? {})
    )
  );

  bridgeHandle(
    "remote:remove",
    safe("remote:remove", async (event: HandlerContext, id: unknown) => removeRemoteLibraryFor(event, id))
  );

  bridgeHandle(
    "remote:refresh",
    safe("remote:refresh", async (_event, id: unknown) => refreshRemoteLibraryFor(id))
  );

  bridgeHandle(
    "remote:tracks",
    safe("remote:tracks", async (_event, id: unknown, opts: Record<string, unknown>) => {
      const denied = requireServer();
      if (denied) return denied;
      const db = getLibraryDb();
      const row = getRemoteLibraryRow(db, id);
      if (!row) return { error: "Remote library not found." };
      return listRemoteTracks(db, row.id, opts ?? {});
    })
  );

  bridgeHandle(
    "remote:keepOffline",
    safe("remote:keepOffline", async (_event, id: unknown, trackIds: unknown) => keepOfflineFor(id, trackIds))
  );

  bridgeHandle(
    "remote:evict",
    safe("remote:evict", async (_event, id: unknown, trackIds: unknown) => evictOfflineFor(id, trackIds))
  );

  bridgeHandle(
    "remote:streamUrl",
    safe("remote:streamUrl", async (event: HandlerContext, remoteTrackId: unknown) => {
      const denied = requireServer();
      if (denied) return denied;
      // A token is bound to a session, and the desktop window has none: it
      // plays from `media://`, which cannot reach a peer. Web only, as designed.
      if (event.sessionId === undefined) return { error: "Remote libraries play in the web app." };
      if (typeof remoteTrackId !== "number") return { error: "Track not found." };
      const db = getLibraryDb();
      const track = remoteTrackById(db, remoteTrackId);
      const row = track ? getRemoteLibraryRow(db, track.remote_library_id) : null;
      if (!track || !row || row.status === "revoked") return { error: "Track not found." };
      return { url: remoteMediaUrl(track.id, event.sessionId) };
    })
  );
}
