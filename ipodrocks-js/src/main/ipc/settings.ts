import { handle as bridgeHandle, type HandlerContext } from "../host/bridge";
import { safe } from "./common";
import { denyIfNotOwner, OWNER_ONLY_SETTINGS_MESSAGE } from "../../server/auth/sessions";
import {
  getOpenRouterConfig,
  setOpenRouterConfig,
  getHarmonicPrefs,
  setHarmonicPrefs,
  getRatingPrefs,
  setRatingPrefs,
  type HarmonicPrefs,
  type RatingPrefs,
} from "../utils/prefs";
import type { OpenRouterConfig } from "../../shared/types";

/**
 * Every setter here is owner-gated, and so is anything that reveals credential
 * material.
 *
 * These are *server-wide* prefs — one `ipodrocks-prefs.json` — not per-identity
 * state, and `/api/invoke` checks authentication and nothing else. Left open,
 * any allowlisted guest could swap the OpenRouter key for one of their own and
 * have the owner's Rocksy traffic (library context, chat history, the app-data
 * paths the system prompt carries) sent to an account they can read; clear it
 * and switch the assistant off for everyone; or flip `tagRatingAlwaysWins` so
 * the next scan overwrites the whole library's ratings. Same rule as
 * `ipc/server.ts`, same function.
 *
 * The *getters* stay open because every client's UI needs them — FloatChat,
 * Savant and the playlist panel ask "is there a key?" before offering the
 * assistant — but a guest's copy of the OpenRouter config says only that:
 * no model, no site fields, no last four characters of the owner's key.
 */
function requireOwner(ctx: HandlerContext): { error: string } | null {
  return denyIfNotOwner(ctx.sessionId, OWNER_ONLY_SETTINGS_MESSAGE);
}

export function registerSettingsHandlers(): void {
  bridgeHandle(
    "settings:getOpenRouterConfig",
    safe("settings:getOpenRouterConfig", async (event) => {
      const cfg = getOpenRouterConfig();
      if (!cfg) return null;
      if (requireOwner(event)) {
        // "Configured, and not yours to see." The renderer only ever tests
        // `apiKey.trim()` for truthiness outside the owner's Settings form.
        return { apiKey: cfg.apiKey ? "••••••••" : "", model: "" };
      }
      // Return a masked key so the full secret never reaches the renderer.
      // The renderer uses the mask char (•) as a sentinel meaning "unchanged".
      const { apiKey, ...rest } = cfg;
      const masked =
        apiKey && apiKey.length >= 8
          ? "••••••••" + apiKey.slice(-4)
          : "••••••••";
      return { ...rest, apiKey: masked };
    })
  );

  bridgeHandle(
    "settings:setOpenRouterConfig",
    safe("settings:setOpenRouterConfig", async (event, config: OpenRouterConfig | null) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      if (config && config.apiKey?.includes("•")) {
        // Renderer sent back the masked value — preserve the stored key; only
        // update other fields (e.g. model).
        const existing = getOpenRouterConfig();
        setOpenRouterConfig({ apiKey: existing?.apiKey ?? "", model: config.model });
      } else {
        setOpenRouterConfig(config);
      }
    })
  );

  bridgeHandle(
    "settings:testOpenRouter",
    safe("settings:testOpenRouter", async (event, configOverride?: { apiKey: string; model: string } | null) => {
      // Gated even though it writes nothing: with an override it is the server
      // calling OpenRouter with any key a guest likes, and without one it
      // spends the owner's key. Shape matches the handler's own failure.
      const denied = requireOwner(event);
      if (denied) return { ok: false, error: denied.error };
      // If the renderer passed a masked key, ignore it and use the stored key.
      const override =
        configOverride?.apiKey?.includes("•") ? null : configOverride;
      const config = override ?? getOpenRouterConfig();
      if (!config?.apiKey?.trim()) return { ok: false, error: "No API key" };
      const { callOpenRouter } = await import("../llm/openRouterClient");
      await callOpenRouter(
        [{ role: "user", content: "Reply with exactly: OK" }],
        { apiKey: config.apiKey, model: config.model?.trim() || "anthropic/claude-sonnet-4.6" },
        false
      );
      return { ok: true };
    })
  );

  bridgeHandle(
    "settings:getHarmonicPrefs",
    safe("settings:getHarmonicPrefs", async () => getHarmonicPrefs())
  );

  bridgeHandle(
    "settings:setHarmonicPrefs",
    safe("settings:setHarmonicPrefs", async (event, prefs: HarmonicPrefs) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      setHarmonicPrefs(prefs);
    })
  );

  bridgeHandle(
    "settings:getRatingPrefs",
    safe("settings:getRatingPrefs", async () => getRatingPrefs())
  );

  bridgeHandle(
    "settings:setRatingPrefs",
    safe("settings:setRatingPrefs", async (event, prefs: RatingPrefs) => {
      const denied = requireOwner(event);
      if (denied) return denied;
      setRatingPrefs(prefs);
    })
  );
}
