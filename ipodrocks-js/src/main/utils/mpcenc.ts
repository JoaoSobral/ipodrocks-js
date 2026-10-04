import { spawnSync } from "child_process";
import { getEncoderEnv } from "./encoder-env";

const SPAWN_OPTS = {
  encoding: "utf8" as const,
  timeout: 3000,
  windowsHide: true,
  env: getEncoderEnv(),
};

/**
 * Checks if the mpcenc (Musepack encoder) binary is available on the system PATH.
 *
 * A spawn that did not fail *is* the answer: Node reports a missing binary as
 * `error` (ENOENT), never as an exit status. mpcenc 1.30 exits 1 for
 * `--version`, which is why this does not insist on 0 — and why it no longer
 * falls back to `which`, which is absent from the distroless server image and
 * read a perfectly good mpcenc there as "not found".
 */
export function isMpcencAvailable(): boolean {
  try {
    const result = spawnSync("mpcenc", ["--version"], SPAWN_OPTS);
    return !result.error;
  } catch {
    return false;
  }
}
