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
 * Instead we reject the dangerous shapes: empty, null bytes, non-absolute, and
 * a bare filesystem root. The last one matters because mirror sync deletes
 * "extra" files under the mount path — pointing a device at `/` or `C:\` could
 * otherwise sweep the whole disk. Returns the resolved absolute path.
 */
export function sanitizeMountPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("Mount path cannot be empty");
  }
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0")) {
    throw new Error("Mount path contains an invalid character");
  }
  const resolved = path.resolve(trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("Mount path cannot be a filesystem root");
  }
  return resolved;
}
