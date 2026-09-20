import { handle as bridgeHandle } from "../host/bridge";
import { safe } from "./common";
import { getWebServerPrefs, setWebServerPrefs, type WebServerPrefs } from "../utils/prefs";
import {
  ensureServerStarted,
  getServerStatus,
  stopServerIfRunning,
} from "../../server";

/**
 * The Settings → Web Server card's channels.
 *
 * These are registered like every other domain, which means they are reachable
 * *over the web server itself* — that is intentional and is why
 * `server:setConfig` never restarts the listener implicitly: a remote client
 * changing the port would otherwise cut its own connection mid-request and
 * never learn whether the change took. The restart is an explicit second call.
 */
export function registerServerHandlers(): void {
  bridgeHandle(
    "server:getStatus",
    safe("server:getStatus", async () => ({
      ...getServerStatus(),
      prefs: getWebServerPrefs(),
    }))
  );

  bridgeHandle(
    "server:setConfig",
    safe("server:setConfig", async (_event, prefs: WebServerPrefs) => {
      const next: WebServerPrefs = {};
      if (typeof prefs?.enabled === "boolean") next.enabled = prefs.enabled;
      if (typeof prefs?.host === "string") next.host = prefs.host.trim();
      if (typeof prefs?.port === "number" && prefs.port > 0 && prefs.port < 65536) {
        next.port = Math.floor(prefs.port);
      }
      if (typeof prefs?.publicUrl === "string") {
        next.publicUrl = prefs.publicUrl.trim();
      }
      if (Array.isArray(prefs?.trustedProxies)) {
        next.trustedProxies = prefs.trustedProxies.map(String);
      }
      if (Array.isArray(prefs?.allowedOrigins)) {
        next.allowedOrigins = prefs.allowedOrigins.map(String);
      }
      if (prefs?.tls === null || typeof prefs?.tls === "object") {
        next.tls = prefs.tls
          ? {
              certPath: String(prefs.tls.certPath ?? ""),
              keyPath: String(prefs.tls.keyPath ?? ""),
            }
          : null;
      }
      setWebServerPrefs(next);
      return { prefs: getWebServerPrefs() };
    })
  );

  bridgeHandle(
    "server:start",
    safe("server:start", async () => {
      setWebServerPrefs({ enabled: true });
      return ensureServerStarted();
    })
  );

  bridgeHandle(
    "server:stop",
    safe("server:stop", async () => {
      setWebServerPrefs({ enabled: false });
      return stopServerIfRunning();
    })
  );
}
