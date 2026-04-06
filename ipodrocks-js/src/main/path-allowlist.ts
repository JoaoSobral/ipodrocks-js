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
