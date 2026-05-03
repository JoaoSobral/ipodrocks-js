import * as fs from "fs";
import * as path from "path";

/**
 * Detect whether a device mount path points at a real connected volume.
 *
 * On macOS/Linux: a real mounted volume always has a different `dev` than its
 * parent directory (because it's a separate filesystem), while a regular folder
 * on the main filesystem (or an orphan directory left behind after ejection)
 * shares the parent's `dev`.
 *
 * `fs.existsSync` alone is not reliable because:
 *   - macOS/Linux can leave an empty orphan directory after ejection
 *   - a local folder named like a device always exists but is not connected
 *
 * On Windows (no POSIX dev ids in a meaningful way), we fall back to checking
 * that the path exists and is a directory; Windows drive letters are naturally
 * isolated so this is sufficient there.
 */
export function isDeviceMountPathOnline(mountPath: string): boolean {
  if (!mountPath) return false;
  try {
    const resolved = path.resolve(mountPath);
    const pathStat = fs.statSync(resolved);
    if (!pathStat.isDirectory()) return false;
    if (process.platform === "win32") return true;
    const parentStat = fs.statSync(path.dirname(resolved));
    return pathStat.dev !== parentStat.dev;
  } catch {
    return false;
  }
}
