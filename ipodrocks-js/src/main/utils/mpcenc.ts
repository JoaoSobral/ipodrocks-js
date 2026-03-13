import { spawnSync } from "child_process";

const SPAWN_OPTS = {
  encoding: "utf8" as const,
  timeout: 3000,
  windowsHide: true,
  env: process.env,
};

/**
 * Checks if the mpcenc (Musepack encoder) binary is available on the system PATH.
 * Uses shell for lookup when needed so Linux/Electron sees the same PATH as the user.
 */
export function isMpcencAvailable(): boolean {
  try {
    const result = spawnSync("mpcenc", ["--version"], SPAWN_OPTS);
    if (result.status === 0) return true;
    if (result.error) return false;
    // Some mpcenc builds exit non-zero for --version; try resolving via PATH
    const which =
      process.platform === "win32"
        ? spawnSync("where", ["mpcenc"], SPAWN_OPTS)
        : spawnSync("which", ["mpcenc"], SPAWN_OPTS);
    return which.status === 0 && (which.stdout?.trim()?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
