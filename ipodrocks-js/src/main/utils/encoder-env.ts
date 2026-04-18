import { platform, env } from "process";

/**
 * Returns process.env augmented with common encoder binary locations.
 * Needed because Electron launched from a GUI does not inherit the user's
 * shell PATH — /opt/homebrew/bin (Apple Silicon) and /usr/local/bin (Intel)
 * are absent without this.
 */
export function getEncoderEnv(): NodeJS.ProcessEnv {
  const basePath = env.PATH || "";
  const delim = platform === "win32" ? ";" : ":";
  const home = env.HOME || env.USERPROFILE || "";
  const extras =
    platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          home ? `${home}/.local/bin` : "",
        ];
  return {
    ...env,
    PATH: [...extras, basePath].filter(Boolean).join(delim),
  };
}
