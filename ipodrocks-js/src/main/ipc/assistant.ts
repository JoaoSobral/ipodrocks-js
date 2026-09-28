import { handle as bridgeHandle, type HandlerContext } from "../host/bridge";
import { callerSubject } from "../../server/auth/sessions";
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
 * `sessionId` is carried through so the gated tools can ask who is chatting.
 * It is undefined over Electron IPC, which they read as "the desktop window on
 * the machine holding the database" — see `ownerGate()` / `deviceGate()` in
 * `assistant/tools.ts`.
 *
 * `sender` is the *caller's own* transport: the Electron window that asked, or
 * the web session's socket fan-out. The trigger tools (`library_scan`,
 * `shadow_rebuild`, `device_sync`) push to it, never to "the first desktop
 * window", which over the web would be somebody else's screen.
 */
function buildToolContext(
  db: import("better-sqlite3").Database,
  event: HandlerContext
): AiToolContext {
  return {
    db,
    getLibrary,
    getPlaylistCore,
    getDevicesCore,
    getPodcastIndexConfig,
    sessionId: event.sessionId,
    sender: event.sender,
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
      // Whose conversation this is. Null over Electron IPC, which has no
      // identity and is the machine holding the database — and *only* there:
      // `callerSubject()` throws for a web caller it cannot name rather than
      // hand it the desktop owner's history and pinned memories. Resolved
      // before anything else, so a refused call touches no rows at all.
      const subject = callerSubject(event);
      const db = getLibrary().getConnection();
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
      const toolCtx = buildToolContext(db, event);
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
      // Same fail-closed rule as the chat turn. Every gate a tool applies reads
      // the live session and already refuses an unnamed caller; this makes the
      // refusal uniform, before any tool runs, rather than per tool.
      callerSubject(event);
      const db = getLibrary().getConnection();
      const toolCtx = buildToolContext(db, event);
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
      const subject = callerSubject(event); // throws for an unnamed web caller
      return loadAssistantHistory(getLibrary().getConnection(), subject);
    })
  );

  bridgeHandle(
    "assistant:history:clear",
    safe("assistant:history:clear", async (event) => {
      // Never the desktop partition for a web caller: an unresolvable session
      // clearing "null" would erase the owner's history, pinned memories and all.
      const subject = callerSubject(event);
      clearAssistantHistory(getLibrary().getConnection(), subject);
    })
  );
}
