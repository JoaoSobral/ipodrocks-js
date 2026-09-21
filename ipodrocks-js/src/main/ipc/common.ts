import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { HandlerContext } from "../host/bridge";
import type { DeviceTransport } from "../../shared/types";
import { deviceAdminBlock, deviceLocalityBlock } from "../../shared/device-locality";
import { pathMatchesAllowedPrefix } from "../path-allowlist";
import { subjectForSessionId } from "../../server/auth/sessions";
import { Library } from "../library/library";
import { DevicesCore } from "../devices/devices-core";
import { PlaylistCore } from "../playlists/playlist-core";

// ---------------------------------------------------------------------------
// Singletons — shared by every IPC domain module
// ---------------------------------------------------------------------------

let library: Library | null = null;
let devicesCore: DevicesCore | null = null;
let playlistCore: PlaylistCore | null = null;

export function getLibrary(): Library {
  if (!library) {
    library = new Library();
    devicesCore = new DevicesCore(library.getConnection());
  }
  return library;
}

export function getLibraryDb(): import("better-sqlite3").Database {
  return getLibrary().getConnection();
}

export function getPlaylistCore(): PlaylistCore {
  if (!playlistCore) {
    playlistCore = new PlaylistCore(getLibrary().getConnection());
  }
  return playlistCore;
}

export function getDevicesCore(): DevicesCore {
  const lib = getLibrary();
  if (!devicesCore) {
    devicesCore = new DevicesCore(lib.getConnection());
  }
  return devicesCore;
}

// ---------------------------------------------------------------------------
// safe() wrapper + error sanitization
// ---------------------------------------------------------------------------

export type Handler = (event: HandlerContext, ...args: any[]) => Promise<unknown>;

/**
 * Removes absolute file-system paths from an error message before it is sent
 * to the renderer, preventing internal path disclosure (e.g. EACCES messages).
 * The original message is still logged in full on the main process.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    // Unix absolute paths
    .replace(/(?:\/[^\s:,'"()\[\]]+)+/g, "[path]")
    // Windows absolute paths (C:\... or C:/...)
    .replace(/(?:[A-Za-z]:[/\\][^\s:,'"()\[\]]+)+/g, "[path]");
}

export function safe(channel: string, fn: Handler): Handler {
  return async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ipc] ${channel} — ${message}`);
      return { error: sanitizeErrorMessage(message) };
    }
  };
}

// ---------------------------------------------------------------------------
// Library folder path validation
// ---------------------------------------------------------------------------

/**
 * Allowed root prefixes for library folder paths.
 * Includes home dir (all platforms) plus platform-specific external drive roots.
 */
function getAllowedPathPrefixes(): string[] {
  const prefixes = [os.homedir()];
  if (process.platform === "darwin") {
    prefixes.push("/Volumes");
  } else if (process.platform === "linux") {
    prefixes.push("/media", "/mnt", "/run/media");
  } else if (process.platform === "win32") {
    // Allow all drive letters on Windows (C:\, D:\, etc.)
    for (let c = 65; c <= 90; c++) {
      prefixes.push(`${String.fromCharCode(c)}:\\`);
    }
  }
  return prefixes;
}

/** Validates a folder path for library operations. Returns resolved path or error. */
export function validateFolderPath(rawPath: string): { path: string } | { error: string } {
  if (!rawPath || typeof rawPath !== "string") {
    return { error: "Invalid path" };
  }
  const resolved = path.resolve(rawPath.trim());

  // Verify the path exists and is a directory before resolving symlinks
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: "Path is not a directory" };
    }
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }

  // Resolve symlinks to get the real path and validate against allowed prefixes
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }

  // Verify the real (symlink-resolved) path falls under an allowed root prefix (F2)
  const allowed = getAllowedPathPrefixes();
  const isAllowed = allowed.some((prefix) =>
    pathMatchesAllowedPrefix(realPath, prefix, process.platform)
  );
  if (!isAllowed) {
    return { error: "Path is outside allowed directories" };
  }

  return { path: realPath };
}

// ---------------------------------------------------------------------------
// Track map helpers (shared by sync + device check)
// ---------------------------------------------------------------------------

/** Builds path→track maps for music, podcast, audiobook from a single getTracks call. */
export function buildLibraryTrackMaps(lib: Library): {
  music: Record<string, Record<string, unknown>>;
  podcast: Record<string, Record<string, unknown>>;
  audiobook: Record<string, Record<string, unknown>>;
} {
  const all = lib.getTracks();
  const music: Record<string, Record<string, unknown>> = {};
  const podcast: Record<string, Record<string, unknown>> = {};
  const audiobook: Record<string, Record<string, unknown>> = {};
  for (const t of all) {
    const rec = t as unknown as Record<string, unknown>;
    const ct = (t.contentType ?? "music") as string;
    if (ct === "music") music[t.path] = rec;
    else if (ct === "podcast") podcast[t.path] = rec;
    else if (ct === "audiobook") audiobook[t.path] = rec;
  }
  return { music, podcast, audiobook };
}

/**
 * Rewrites a library path→track map so it is keyed by the corresponding shadow
 * library path. Tracks with no shadow entry are dropped. Used by both the
 * device-check preview and the actual sync when a device sources from a shadow
 * library.
 */
export function remapTrackMapToShadow(
  trackMap: Record<string, Record<string, unknown>>,
  shadowTrackMap: Map<number, string>
): Record<string, Record<string, unknown>> {
  const remapped: Record<string, Record<string, unknown>> = {};
  for (const [, info] of Object.entries(trackMap)) {
    const trackId = info.id as number;
    const shadowPath = shadowTrackMap.get(trackId);
    if (shadowPath) {
      remapped[shadowPath] = { ...info, path: shadowPath };
    }
  }
  return remapped;
}

// ---------------------------------------------------------------------------
// Device locality
// ---------------------------------------------------------------------------

/**
 * Refuses an operation on a device this caller's machine cannot reach.
 *
 * `ctx.sessionId` is the whole test: the web transport sets it, Electron IPC
 * does not. So "am I the browser or the desktop window" needs no new plumbing
 * and no client-supplied claim — the transport that carried the call answers
 * it, which is the only source that cannot be lied to.
 *
 * Returns the `{ error }` a handler should return, or null to proceed.
 */
export function blockWrongLocality(
  ctx: HandlerContext,
  transport: DeviceTransport | undefined
): { error: string } | null {
  const reason = deviceLocalityBlock(transport, ctx.sessionId !== undefined);
  return reason ? { error: reason } : null;
}

/**
 * Refuses a channel whose effect is a native dialog on the *host's* screen.
 *
 * A native dialog belongs to whoever is sitting at the host, and a web client
 * is by definition not. With the desktop app hosting the server the host does
 * have dialogs, so an unguarded call opens a sheet on the owner's screen and --
 * because the sheet is parented to the app window -- blocks their UI until
 * somebody standing there dismisses it. `app:hasNativeDialogs` already tells a
 * web client it has none; this is what makes that answer true. Every
 * `getHostDialogs()` call site goes through this.
 */
export function blockWebClientDialog(ctx: HandlerContext): { error: string } | null {
  return ctx.sessionId === undefined
    ? null
    : {
        error:
          "A native dialog cannot be opened on the server's screen from a browser.",
      };
}

/**
 * Refuses an operation on a browser-held device that belongs to someone else.
 *
 * `devices.web_owner_subject` exists so one allowlisted account cannot take
 * over another's player, and `device-session.ts` refuses a cross-account
 * *attach* for exactly that reason. Nothing checked it afterwards. The other
 * two guards here are transport-shaped, not identity-shaped: "is the caller a
 * web client, and is the device a web device" is a condition *every*
 * allowlisted identity satisfies for *every* web device. So once a device was
 * attached, any other account could name its id and reach the same
 * `RemoteDeviceFs` — including `deviceFs.rm(recursive)` inside the folder its
 * real owner picked in their own browser.
 *
 * The admission rules mirror the attach path deliberately, so the two cannot
 * drift: Electron IPC (`sessionId === undefined`) is the machine holding the
 * database and is trusted; a non-web device is the locality guards' business,
 * not this one's; and a **null owner admits**, because that is a device
 * registered before the column existed and inventing an owner for one would
 * strand a player nobody can reconnect.
 */
export function blockWrongDeviceOwner(
  ctx: HandlerContext,
  deviceId: number
): { error: string } | null {
  const reason = deviceOwnerBlock(ctx.sessionId, deviceId);
  return reason ? { error: reason } : null;
}

/**
 * The same decision keyed on a bare session id, for callers that hold one
 * without a {@link HandlerContext} — notably the assistant tools, which reach
 * these operations through their own dispatcher and would otherwise skip every
 * guard the IPC handlers apply.
 */
export function deviceOwnerBlock(
  sessionId: string | undefined,
  deviceId: number
): string | null {
  if (sessionId === undefined) return null;
  let row: { transport?: string; web_owner_subject?: string | null } | undefined;
  try {
    row = getLibrary()
      .getConnection()
      .prepare("SELECT transport, web_owner_subject FROM devices WHERE id = ?")
      .get(deviceId) as typeof row;
  } catch {
    return null; // pre-migration column; the locality guards still apply
  }
  if (!row || row.transport !== "web") return null;
  const owner = row.web_owner_subject ?? null;
  if (owner === null) return null;
  if (owner === subjectForSessionId(sessionId)) return null;
  return (
    "That device belongs to a different account. Only the account that " +
    "added it can use or change it."
  );
}

/**
 * Refuses an *edit or delete* of a device this caller has no business changing.
 *
 * Narrower than {@link blockWrongLocality}: the desktop app may still remove a
 * remote device (somebody has to be able to tidy up a browser that never comes
 * back), while a browser may not touch a server-attached one at all.
 */
export function blockWrongAdmin(
  ctx: HandlerContext,
  transport: DeviceTransport | undefined
): { error: string } | null {
  const reason = deviceAdminBlock(transport, ctx.sessionId !== undefined);
  return reason ? { error: reason } : null;
}
