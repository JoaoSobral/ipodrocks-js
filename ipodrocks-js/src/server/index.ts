import { startServer, type RunningServer } from "./http";
import { loadServerConfig } from "./config";
import { countIdentities, getOrCreateClaimToken } from "./auth/identities";

export { startServer } from "./http";
export type { RunningServer } from "./http";
export { loadServerConfig, DEFAULT_PORT, DEFAULT_HOST } from "./config";

/**
 * One server per process, started and stopped by the Settings toggle or by the
 * daemon entry point.
 *
 * A module-level singleton is right here and wrong almost everywhere else in
 * this codebase: there is exactly one listening socket, and "is the server
 * running" is a property of the process, not of a session.
 */

export interface ServerStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  host: string | null;
  /** Non-null only while nobody has claimed ownership. */
  claimToken: string | null;
  identityCount: number;
  providers: string[];
  tls: boolean;
  publicUrl: string | null;
  lastError: string | null;
}

let running: RunningServer | null = null;
let lastError: string | null = null;
let starting: Promise<RunningServer> | null = null;

export function isServerRunning(): boolean {
  return running !== null;
}

export async function ensureServerStarted(): Promise<ServerStatus> {
  if (running) return getServerStatus();
  if (starting) {
    await starting.catch(() => {});
    return getServerStatus();
  }
  starting = startServer();
  try {
    running = await starting;
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[server] failed to start: ${lastError}`);
  } finally {
    starting = null;
  }
  return getServerStatus();
}

export async function stopServerIfRunning(): Promise<ServerStatus> {
  const current = running;
  running = null;
  if (current) {
    try {
      await current.stop();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return getServerStatus();
}

export function getServerStatus(): ServerStatus {
  const config = running?.config ?? loadServerConfig();
  let identityCount = 0;
  let claimToken: string | null = null;
  try {
    identityCount = countIdentities();
    claimToken = getOrCreateClaimToken();
  } catch {
    // The server database is only created once the server has run; before that
    // there is genuinely nothing to report, and failing here would make the
    // Settings card unable to render.
  }
  return {
    running: running !== null,
    url: running?.url ?? null,
    port: running?.port ?? null,
    host: config.host,
    claimToken,
    identityCount,
    providers: (["google", "github", "facebook"] as const).filter(
      (p) => config.oauth[p] !== null
    ),
    tls: config.tls !== null,
    publicUrl: config.publicUrl,
    lastError,
  };
}
