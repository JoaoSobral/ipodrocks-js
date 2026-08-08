import * as path from "path";

/** Matches a Windows drive root prefix only, e.g. `C:\` or `D:\`. */
const WIN_DRIVE_ROOT = /^[A-Za-z]:\\$/;

/**
 * Returns true if realPath is the given allowed root or a subdirectory/file path under it.
 * Windows drive roots (`X:\`) must match paths like `X:\Music` with a single backslash after
 * the colon; appending path.sep twice was incorrect (see path validation / non-C: drives).
 */
export function pathMatchesAllowedPrefix(
  realPath: string,
  prefix: string,
  platform: NodeJS.Platform
): boolean {
  if (realPath === prefix) {
    return true;
  }
  if (platform === "win32" && WIN_DRIVE_ROOT.test(prefix)) {
    const r = realPath.toLowerCase();
    const p = prefix.toLowerCase();
    return r === p || r.startsWith(p);
  }
  // Use platform-specific sep so validation matches the target OS (tests may run on another OS).
  const sep = platform === "win32" ? path.win32.sep : path.posix.sep;
  return realPath.startsWith(prefix + sep);
}

/**
 * Normalizes and validates a device mount path. A device can legitimately be
 * mounted almost anywhere (removable-media roots, dev-mode folders, temp dirs
 * in tests), so we cannot use a fixed prefix allowlist like library folders.
 * Instead we reject the dangerous shapes: empty, null bytes, and a bare POSIX
 * filesystem root. That last guard exists because mirror sync deletes "extra"
 * files under the mount path — but the deletes are scoped to the content
 * subfolders (`mountPath/Music`, `/Podcasts`, `/Audiobooks`), never the mount
 * root itself, so a Windows drive root (`E:\`) — the normal place an iPod /
 * Rockbox device mounts — is safe and allowed. `/` is never a real device
 * mount, so it stays rejected. Returns the resolved absolute path.
 *
 * `platform` defaults to the host but can be overridden so validation matches a
 * target OS (tests may run on another OS), matching `pathMatchesAllowedPrefix`.
 */
export function sanitizeMountPath(
  rawPath: unknown,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("Mount path cannot be empty");
  }
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0")) {
    throw new Error("Mount path contains an invalid character");
  }
  const impl = platform === "win32" ? path.win32 : path.posix;
  const resolved = impl.resolve(trimmed);
  if (resolved === impl.parse(resolved).root) {
    const isWindowsDriveRoot =
      platform === "win32" && WIN_DRIVE_ROOT.test(resolved);
    if (!isWindowsDriveRoot) {
      throw new Error("Mount path cannot be a filesystem root");
    }
  }
  return resolved;
}
