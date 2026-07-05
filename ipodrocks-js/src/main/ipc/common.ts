import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { pathMatchesAllowedPrefix } from "../path-allowlist";
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

export type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>;

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
