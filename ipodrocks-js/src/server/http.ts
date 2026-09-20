import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import express, { type Express, type Request } from "express";
import session from "express-session";
import {
  allowedOriginsFor,
  loadServerConfig,
  readTlsPair,
  type ServerConfig,
} from "./config";
import { closeServerDb, getSetting, setSetting } from "./db";
import { SqliteSessionStore } from "./session-store";
import { configurePassport, passport, resetPassport } from "./auth/passport-setup";
import {
  authenticatedSubject,
  createAuthRouter,
  currentIdentity,
  requireAuth,
} from "./auth/routes";
import { getOrCreateClaimToken } from "./auth/identities";
import { attachEventsServer, resetEventSessions, type EventsServer } from "./events";
import { handleInvoke, MAX_INVOKE_BODY_BYTES } from "./invoke-route";
import { handleMediaRequest } from "./media-route";
import { issueMediaToken, resetMediaTokenKey } from "./media-token";
import { setMediaUrlEncoder } from "../main/player/media-url";

/**
 * The web server.
 *
 * It does not own any application logic. Handlers are looked up in
 * `host/bridge.ts` — the same registry Electron's transport attaches to — so
 * the desktop app with the server switched on serves its own window over IPC
 * and a remote browser over HTTP against one set of handlers, with one
 * database. That is the whole reason Phase 1 turned `ipcMain.handle` into a
 * registry.
 */

export interface RunningServer {
  url: string;
  port: number;
  config: ServerConfig;
  stop(): Promise<void>;
}

const SESSION_COOKIE = "ipodrocks.sid";
const SESSION_SECRET_KEY = "session_secret";

/**
 * The session signing secret.
 *
 * Generated and stored on first run rather than derived from anything, so it
 * survives restarts — a fresh secret every boot logs everyone out, which on a
 * daemon that restarts on deploy is indistinguishable from the app being
 * broken. `IPODROCKS_SESSION_SECRET` overrides it for a deployment that wants
 * the secret outside the data volume.
 */
function resolveSessionSecret(config: ServerConfig): string {
  if (config.sessionSecret) return config.sessionSecret;
  const existing = getSetting(SESSION_SECRET_KEY);
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString("base64");
  setSetting(SESSION_SECRET_KEY, generated);
  return generated;
}

/**
 * The renderer bundle, served from disk.
 *
 * `dist/renderer` in a normal build. `vite.config.ts` uses `base: "./"`, which
 * resolves against the document's own URL — fine at `/`, and the reason the
 * server rewrites nothing.
 */
function rendererDir(): string {
  // dist/main/server/http.js → ../../renderer
  const fromBuild = path.resolve(__dirname, "..", "..", "renderer");
  if (fs.existsSync(path.join(fromBuild, "index.html"))) return fromBuild;
  return path.resolve(process.cwd(), "dist", "renderer");
}

/**
 * The Content-Security-Policy.
 *
 * The one baked into `src/renderer/index.html` as a `<meta http-equiv>` cannot
 * be reused: it names the `media:` scheme, which does not exist in a browser
 * tab, and it has no `connect-src` at all — so it would permit any outbound
 * fetch while forbidding the media the page actually plays. The meta tag is
 * stripped from the served HTML and replaced by this header, which a `<meta>`
 * cannot express anyway (`frame-ancestors` is header-only).
 */
export function buildCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "media-src 'self' blob:",
    // Same-origin XHR/fetch and the WebSocket. `'self'` does not cover ws(s):,
    // so both schemes are named explicitly.
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Removes the desktop `<meta http-equiv="Content-Security-Policy">`. Leaving
 *  it in place would intersect with the header and block the app's own API
 *  calls, since the meta policy has no `connect-src` and `default-src 'self'`
 *  does not permit a WebSocket. */
export function stripCspMeta(html: string): string {
  return html.replace(
    /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi,
    ""
  );
}

/**
 * Pins relative asset URLs to the root.
 *
 * `vite.config.ts` builds with `base: "./"`, so `index.html` references
 * `./assets/index-*.js`. That resolves correctly at `/` and nowhere else — and
 * the SPA fallback serves this same document for *any* unmatched path, so
 * anyone who bookmarks or is redirected to `/anything` gets a page whose script
 * tags point at `/anything/assets/…` and a blank screen. A `<base>` costs one
 * tag and removes the whole class of problem; changing Vite's `base` would
 * break the desktop build, which loads the file over `file://`.
 */
export function injectBaseHref(html: string): string {
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n  <base href="/">`);
}

function serveIndex(dir: string, res: express.Response): void {
  const indexPath = path.join(dir, "index.html");
  let html: string;
  try {
    html = fs.readFileSync(indexPath, "utf-8");
  } catch {
    res
      .status(500)
      .type("text/plain")
      .send(
        "Renderer bundle not found. Run `npm run build` before starting the server."
      );
    return;
  }
  res.type("text/html").send(injectBaseHref(stripCspMeta(html)));
}

export async function startServer(
  overrides?: Partial<ServerConfig>
): Promise<RunningServer> {
  const config = { ...loadServerConfig(), ...overrides } as ServerConfig;

  resetMediaTokenKey();
  resetEventSessions();
  resetPassport();

  const app: Express = express();

  // `trust proxy` is set only to the configured addresses. Left at `true` a
  // direct client could forge `X-Forwarded-For` and walk straight past the
  // rate limiter, which keys on `req.ip`.
  if (config.trustedProxies.length > 0) {
    app.set("trust proxy", config.trustedProxies);
  } else {
    app.set("trust proxy", false);
  }
  app.disable("x-powered-by");

  const secure = config.tls !== null || config.publicUrl?.startsWith("https://") === true;

  const sessionMiddleware = session({
    name: SESSION_COOKIE,
    secret: resolveSessionSecret(config),
    resave: false,
    saveUninitialized: false,
    store: new SqliteSessionStore(),
    cookie: {
      httpOnly: true,
      secure,
      // Lax, not Strict. Strict withholds the cookie on the cross-site
      // navigation the OAuth provider performs on its way back to
      // /api/auth/<provider>/callback, so the callback cannot find the session
      // holding the claim token and every social login fails.
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());

  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", buildCsp());
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    if (secure) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
    }
    next();
  });

  const enabledProviders = configurePassport(config);

  app.use("/api/auth", express.json({ limit: "64kb" }), createAuthRouter({
    config,
    enabledProviders,
  }));

  const subjectFor = (req: Request): string | null => {
    const identity = currentIdentity(req);
    return identity ? `${identity.provider}:${identity.subject}` : null;
  };

  app.post(
    "/api/invoke/:channel",
    requireAuth(config),
    express.json({ limit: MAX_INVOKE_BODY_BYTES }),
    (req, res) => {
      void handleInvoke(req, res, { subjectFor });
    }
  );

  app.get("/api/media/:token", requireAuth(config), handleMediaRequest);
  app.head("/api/media/:token", requireAuth(config), handleMediaRequest);

  // The renderer bundle. Served after the API routes so a file called
  // `api` could never shadow one, and without `index: false` shortcuts that
  // would bypass the CSP-meta strip below.
  const dir = rendererDir();
  app.use(
    express.static(dir, {
      index: false,
      // Hashed asset filenames; the HTML itself is rebuilt each request.
      setHeaders: (res, filePath) => {
        if (/\/assets\//.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    })
  );

  // Everything else is the SPA. An unmatched `/api/*` must 404 as JSON rather
  // than quietly returning the app shell, or a typo'd channel looks to the
  // client like a parse error instead of a missing route.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use((_req, res) => {
    serveIndex(dir, res);
  });

  const tls = readTlsPair(config);
  const httpServer = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, app)
    : http.createServer(app);

  const allowedOrigins = allowedOriginsFor(config);
  const events: EventsServer = attachEventsServer(httpServer, {
    sessionMiddleware,
    allowedOrigins,
    authenticate: (req) => authenticatedSubject(req as unknown as Request, config),
  });

  // Media URLs now have to be tokens. Installed here, torn down in `stop()`,
  // so the desktop app's `media://` scheme comes back if the toggle is turned
  // off again.
  setMediaUrlEncoder((filePath, sessionId) => {
    return `/api/media/${issueMediaToken(filePath, sessionId ?? null)}`;
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const scheme = tls ? "https" : "http";
  const url = config.publicUrl ?? `${scheme}://${config.host}:${port}`;

  const claimToken = getOrCreateClaimToken();
  console.log(`[server] listening on ${scheme}://${config.host}:${port}`);
  if (claimToken) {
    console.log(
      "\n" +
        "  ┌─ First run ────────────────────────────────────────────────┐\n" +
        "  │ This server has no owner yet. Open it in a browser and     │\n" +
        "  │ sign in with this one-time claim token:                    │\n" +
        `  │   ${claimToken.padEnd(57)}│\n` +
        "  │ The first identity to present it becomes the owner; every  │\n" +
        "  │ later login is checked against the allowlist.              │\n" +
        "  └────────────────────────────────────────────────────────────┘\n"
    );
  }
  if (!config.publicUrl && enabledProviders.length === 0) {
    console.log(
      "[server] No OAuth provider is configured. Sign in with a local " +
        "password account — Google and friends need a stable public HTTPS " +
        "hostname, which a LAN install does not have."
    );
  }

  return {
    url,
    port,
    config,
    async stop(): Promise<void> {
      setMediaUrlEncoder(null);
      await events.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      resetEventSessions();
      resetPassport();
      closeServerDb();
    },
  };
}
