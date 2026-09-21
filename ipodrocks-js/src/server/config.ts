import * as fs from "fs";
import { getWebServerPrefs, type WebServerPrefs } from "../main/utils/prefs";

/**
 * Where the server's configuration comes from, and why it is split.
 *
 * *Deployment shape* — port, bind address, public URL, proxies, TLS — lives in
 * `ipodrocks-prefs.json` so the desktop Settings card can write it, and each
 * field takes an environment override so a container can be configured without
 * a prefs file at all.
 *
 * *Third-party OAuth credentials* are environment-only, deliberately. Two
 * reasons: a client secret belonging to someone else's console has no business
 * in a file the app rewrites on every settings save, and the encrypted-prefs
 * route is exactly the one that does not survive the move between hosts (an
 * `_enc*` blob written by Electron's `safeStorage` is unreadable to the
 * daemon — see `host/node-host.ts`). An operator who wants Google login sets
 * two variables; nothing has to migrate.
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface ServerConfig {
  /** Bind address. Defaults to loopback: a tunnel or reverse proxy is the
   *  intended way out, and binding 0.0.0.0 by default would put an install on
   *  the LAN before its owner has set a password. */
  host: string;
  port: number;
  /**
   * The externally visible origin, e.g. `https://ipod.example.com`. OAuth
   * callback URLs are built from it and it is the default allowed WebSocket
   * origin. Null means "derive from the request", which is only safe behind a
   * trusted proxy and is refused for OAuth.
   */
  publicUrl: string | null;
  /** Addresses whose `X-Forwarded-*` headers may be believed. */
  trustedProxies: string[];
  /** Extra origins accepted on the WebSocket upgrade, beyond `publicUrl`. */
  allowedOrigins: string[];
  tls: { certPath: string; keyPath: string } | null;
  sessionSecret: string | null;
  oauth: {
    google: OAuthProviderConfig | null;
    github: OAuthProviderConfig | null;
    facebook: OAuthProviderConfig | null;
  };
  cloudflareAccess: { teamDomain: string; audience: string } | null;
}

export const DEFAULT_PORT = 8780;
export const DEFAULT_HOST = "127.0.0.1";

function envStr(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function envList(name: string): string[] | undefined {
  const v = envStr(name);
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

function envInt(name: string): number | undefined {
  const v = envStr(name);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : undefined;
}

function provider(idVar: string, secretVar: string): OAuthProviderConfig | null {
  const clientId = envStr(idVar);
  const clientSecret = envStr(secretVar);
  // Half a credential pair is a misconfiguration, not a provider: registering
  // the strategy anyway makes passport throw at startup with a message that
  // names neither variable.
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Normalizes an origin to scheme://host[:port], dropping any path. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return null;
  }
}

export function loadServerConfig(prefs?: WebServerPrefs): ServerConfig {
  const p = prefs ?? getWebServerPrefs();
  const publicUrlRaw = envStr("IPODROCKS_PUBLIC_URL") ?? p.publicUrl ?? null;
  const publicUrl = publicUrlRaw ? normalizeOrigin(publicUrlRaw) : null;

  const certPath = envStr("IPODROCKS_TLS_CERT") ?? p.tls?.certPath;
  const keyPath = envStr("IPODROCKS_TLS_KEY") ?? p.tls?.keyPath;

  const cfTeam = envStr("IPODROCKS_CF_ACCESS_TEAM_DOMAIN");
  const cfAud = envStr("IPODROCKS_CF_ACCESS_AUD");

  return {
    host: envStr("IPODROCKS_SERVER_HOST") ?? p.host ?? DEFAULT_HOST,
    port: envInt("IPODROCKS_SERVER_PORT") ?? p.port ?? DEFAULT_PORT,
    publicUrl,
    trustedProxies: envList("IPODROCKS_TRUSTED_PROXIES") ?? p.trustedProxies ?? [],
    allowedOrigins: (envList("IPODROCKS_ALLOWED_ORIGINS") ?? p.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((o): o is string => o !== null),
    tls: certPath && keyPath ? { certPath, keyPath } : null,
    sessionSecret: envStr("IPODROCKS_SESSION_SECRET") ?? null,
    oauth: {
      google: provider("IPODROCKS_GOOGLE_CLIENT_ID", "IPODROCKS_GOOGLE_CLIENT_SECRET"),
      github: provider("IPODROCKS_GITHUB_CLIENT_ID", "IPODROCKS_GITHUB_CLIENT_SECRET"),
      facebook: provider(
        "IPODROCKS_FACEBOOK_CLIENT_ID",
        "IPODROCKS_FACEBOOK_CLIENT_SECRET"
      ),
    },
    cloudflareAccess: cfTeam && cfAud ? { teamDomain: cfTeam, audience: cfAud } : null,
  };
}

/** Reads the TLS pair, or returns null and logs why. Never throws: a bad cert
 *  path should start the server on HTTP with a loud warning rather than leave
 *  the desktop app's toggle stuck on "starting". */
export function readTlsPair(
  config: ServerConfig
): { cert: Buffer; key: Buffer } | null {
  if (!config.tls) return null;
  try {
    return {
      cert: fs.readFileSync(config.tls.certPath),
      key: fs.readFileSync(config.tls.keyPath),
    };
  } catch (err) {
    console.error(
      `[server] TLS cert/key could not be read (${
        err instanceof Error ? err.message : String(err)
      }) — starting without TLS.`
    );
    return null;
  }
}

/**
 * The origins a browser may present on the WebSocket upgrade.
 *
 * `publicUrl` plus anything explicitly configured, plus the loopback origins
 * the server itself serves — without those last ones a plain
 * `http://127.0.0.1:8780` install could never open its own socket.
 */
export function allowedOriginsFor(config: ServerConfig): string[] {
  const origins = new Set<string>(config.allowedOrigins);
  if (config.publicUrl) origins.add(config.publicUrl);
  const scheme = config.tls ? "https" : "http";
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    origins.add(`${scheme}://${h}:${config.port}`);
  }
  if (config.host !== DEFAULT_HOST && config.host !== "0.0.0.0" && config.host !== "::") {
    origins.add(`${scheme}://${config.host}:${config.port}`);
  }
  return [...origins];
}
