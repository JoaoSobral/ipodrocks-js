import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathMatchesAllowedPrefix } from "../path-allowlist";

function getAllowedPathPrefixes(): string[] {
  const prefixes = [os.homedir()];
  if (process.platform === "darwin") {
    prefixes.push("/Volumes");
  } else if (process.platform === "linux") {
    prefixes.push("/media", "/mnt", "/run/media");
  } else if (process.platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      prefixes.push(`${String.fromCharCode(c)}:\\`);
    }
  }
  return prefixes;
}

/** Path validation for tools — mirrors ipc.ts validateFolderPath. */
export function validateFolderPathForTool(
  rawPath: string
): { path: string } | { error: string } {
  if (!rawPath || typeof rawPath !== "string") return { error: "Invalid path" };
  const resolved = path.resolve(rawPath.trim());
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return { error: "Path is not a directory" };
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }
  const allowed = getAllowedPathPrefixes();
  const isAllowed = allowed.some((prefix) =>
    pathMatchesAllowedPrefix(realPath, prefix, process.platform)
  );
  if (!isAllowed) return { error: "Path is outside allowed directories" };
  return { path: realPath };
}
