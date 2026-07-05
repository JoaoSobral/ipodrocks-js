import { ipcMain } from "electron";
import { safe } from "./common";
import {
  getOpenRouterConfig,
  setOpenRouterConfig,
  getHarmonicPrefs,
  setHarmonicPrefs,
  type HarmonicPrefs,
} from "../utils/prefs";
import type { OpenRouterConfig } from "../../shared/types";

export function registerSettingsHandlers(): void {
  ipcMain.handle(
    "settings:getOpenRouterConfig",
    safe("settings:getOpenRouterConfig", async () => {
      const cfg = getOpenRouterConfig();
      if (!cfg) return null;
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

  ipcMain.handle(
    "settings:setOpenRouterConfig",
    safe("settings:setOpenRouterConfig", async (_event, config: OpenRouterConfig | null) => {
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

  ipcMain.handle(
    "settings:testOpenRouter",
    safe("settings:testOpenRouter", async (_event, configOverride?: { apiKey: string; model: string } | null) => {
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

  ipcMain.handle(
    "settings:getHarmonicPrefs",
    safe("settings:getHarmonicPrefs", async () => getHarmonicPrefs())
  );

  ipcMain.handle(
    "settings:setHarmonicPrefs",
    safe("settings:setHarmonicPrefs", async (_event, prefs: HarmonicPrefs) => {
      setHarmonicPrefs(prefs);
    })
  );
}
