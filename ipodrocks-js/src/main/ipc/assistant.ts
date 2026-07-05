import { app, ipcMain } from "electron";
import { safe, getLibrary, getPlaylistCore, getDevicesCore } from "./common";
import { checkRateLimit } from "../llm/openRouterClient";
import {
  getOpenRouterConfig,
  getPodcastIndexConfig,
  getAutoPodcastSettings,
} from "../utils/prefs";
import { getPodcastsRoot } from "../podcasts/podcast-storage";
import {
  sendAssistantMessage,
  executeConfirmedAction,
  loadAssistantHistory,
  loadNonPinnedHistory,
  saveAssistantMessages,
  clearAssistantHistory,
  pinMessages,
  unpinMessages,
  getPinnedCount,
  MAX_PINNED_MEMORIES,
  type AppPaths,
  type PendingAction,
} from "../assistant/assistantChat";
import type { AiToolContext } from "../assistant/tools";

function buildToolContext(db: import("better-sqlite3").Database): AiToolContext {
  return {
    db,
    getLibrary,
    getPlaylistCore,
    getDevicesCore,
    getPodcastIndexConfig,
  };
}

export function registerAssistantHandlers(): void {
  ipcMain.handle(
    "assistant:chat",
    safe("assistant:chat", async (_event, userMessage: string) => {
      // F4: Rate limit LLM calls
      if (!checkRateLimit("assistant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const db = getLibrary().getConnection();
      const recentHistory = loadNonPinnedHistory(db);
      const fullHistory = [
        ...recentHistory,
        { role: "user" as const, content: userMessage },
      ];
      const userData = app.getPath("userData");
      const autoPodcastSettings = getAutoPodcastSettings();
      const appPaths: AppPaths = {
        userData,
        podcastsRoot: getPodcastsRoot(),
        autoPodcastEnabled: autoPodcastSettings.enabled,
        autoPodcastIntervalMin: autoPodcastSettings.refreshIntervalMinutes,
      };
      const toolCtx = buildToolContext(db);
      const result = await sendAssistantMessage(fullHistory, db, config, appPaths, toolCtx);

      const { reply, playlistCreated, pendingAction, pin, unpinIds, replaceId } = result;

      // When there's a pending action, save an empty placeholder reply (the confirm UI
      // is shown in the renderer; the real reply is stored after confirmation).
      const replyToSave = reply || (pendingAction ? `[Pending: ${pendingAction.summary}]` : "");

      const { userMsgId, assistantMsgId } = saveAssistantMessages(db, userMessage, replyToSave);

      for (const uid of unpinIds ?? []) unpinMessages(db, uid);
      if (replaceId) unpinMessages(db, replaceId);

      if (pin || replaceId) {
        if (replaceId || getPinnedCount(db) < MAX_PINNED_MEMORIES) {
          pinMessages(db, userMsgId, assistantMsgId);
        }
      }

      return { reply, playlistCreated, pendingAction };
    })
  );

  ipcMain.handle(
    "assistant:confirmAction",
    safe("assistant:confirmAction", async (_event, action: PendingAction) => {
      if (!checkRateLimit("assistant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const db = getLibrary().getConnection();
      const toolCtx = buildToolContext(db);
      const rawResult = await executeConfirmedAction(action, toolCtx);
      let resultText: string;
      try {
        const parsed = JSON.parse(rawResult) as Record<string, unknown>;
        if (parsed.error) {
          resultText = `Action failed: ${String(parsed.error)}`;
        } else if (parsed.ok || parsed.created || parsed.deleted || parsed.removed) {
          resultText = `Done! ${action.summary} completed successfully.`;
        } else {
          resultText = `Done! ${action.summary}`;
        }
      } catch {
        resultText = `Done! ${action.summary}`;
      }
      return { reply: resultText };
    })
  );

  ipcMain.handle(
    "assistant:history:load",
    safe("assistant:history:load", async () => {
      const db = getLibrary().getConnection();
      return loadAssistantHistory(db);
    })
  );

  ipcMain.handle(
    "assistant:history:clear",
    safe("assistant:history:clear", async () => {
      const db = getLibrary().getConnection();
      clearAssistantHistory(db);
    })
  );
}
