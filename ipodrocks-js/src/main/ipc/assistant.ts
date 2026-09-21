import { handle as bridgeHandle } from "../host/bridge";
import { subjectForSessionId } from "../../server/auth/sessions";
import { getUserDataPath } from "../host";
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

/**
 * `sessionId` is carried through so the `web_server_*` allowlist tools can ask
 * who is chatting. It is undefined over Electron IPC, which those tools read as
 * "the desktop window on the machine holding the database" — see `ownerGate()`
 * in `assistant/tools.ts`. No other tool looks at it.
 */
function buildToolContext(
  db: import("better-sqlite3").Database,
  sessionId?: string
): AiToolContext {
  return {
    db,
    getLibrary,
    getPlaylistCore,
    getDevicesCore,
    getPodcastIndexConfig,
    sessionId,
  };
}

export function registerAssistantHandlers(): void {
  bridgeHandle(
    "assistant:chat",
    safe("assistant:chat", async (event, userMessage: string) => {
      // F4: Rate limit LLM calls
      if (!checkRateLimit("assistant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const db = getLibrary().getConnection();
      // Whose conversation this is. Null over Electron IPC, which has no
      // identity and is the machine holding the database.
      const subject =
        event.sessionId === undefined ? null : subjectForSessionId(event.sessionId);
      const recentHistory = loadNonPinnedHistory(db, subject);
      const fullHistory = [
        ...recentHistory,
        { role: "user" as const, content: userMessage },
      ];
      const userData = getUserDataPath();
      const autoPodcastSettings = getAutoPodcastSettings();
      const appPaths: AppPaths = {
        userData,
        podcastsRoot: getPodcastsRoot(),
        autoPodcastEnabled: autoPodcastSettings.enabled,
        autoPodcastIntervalMin: autoPodcastSettings.refreshIntervalMinutes,
      };
      const toolCtx = buildToolContext(db, event.sessionId);
      const result = await sendAssistantMessage(
        fullHistory,
        db,
        config,
        appPaths,
        toolCtx,
        subject
      );

      const { reply, playlistCreated, pendingAction, pin, unpinIds, replaceId } = result;

      // When there's a pending action, save an empty placeholder reply (the confirm UI
      // is shown in the renderer; the real reply is stored after confirmation).
      const replyToSave = reply || (pendingAction ? `[Pending: ${pendingAction.summary}]` : "");

      const { userMsgId, assistantMsgId } = saveAssistantMessages(db, userMessage, replyToSave, subject);

      for (const uid of unpinIds ?? []) unpinMessages(db, uid, subject);
      if (replaceId) unpinMessages(db, replaceId, subject);

      if (pin || replaceId) {
        if (replaceId || getPinnedCount(db, subject) < MAX_PINNED_MEMORIES) {
          pinMessages(db, userMsgId, assistantMsgId, subject);
        }
      }

      return { reply, playlistCreated, pendingAction };
    })
  );

  bridgeHandle(
    "assistant:confirmAction",
    safe("assistant:confirmAction", async (event, action: PendingAction) => {
      if (!checkRateLimit("assistant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const db = getLibrary().getConnection();
      const toolCtx = buildToolContext(db, event.sessionId);
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

  bridgeHandle(
    "assistant:history:load",
    safe("assistant:history:load", async (event) => {
      const db = getLibrary().getConnection();
      return loadAssistantHistory(
        db,
        event.sessionId === undefined ? null : subjectForSessionId(event.sessionId)
      );
    })
  );

  bridgeHandle(
    "assistant:history:clear",
    safe("assistant:history:clear", async (event) => {
      const db = getLibrary().getConnection();
      clearAssistantHistory(
        db,
        event.sessionId === undefined ? null : subjectForSessionId(event.sessionId)
      );
    })
  );
}
