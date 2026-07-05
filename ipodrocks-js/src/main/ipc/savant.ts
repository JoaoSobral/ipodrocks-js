import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import { safe, getLibrary, getPlaylistCore } from "./common";
import { LibraryScanner } from "../library/library-scanner";
import { getHarmonicPrefs, getOpenRouterConfig } from "../utils/prefs";
import { checkRateLimit } from "../llm/openRouterClient";
import { generateSavantPlaylist } from "../savant/savantEngine";
import {
  startMoodChat,
  processMoodChatTurn,
  type MoodChatState,
} from "../savant/moodChat";
import {
  startSavantPlaylistChat,
  processSavantPlaylistChatTurn,
  type SavantPlaylistChatState,
} from "../savant/savantPlaylistChat";
import { logActivity } from "../activity/activity-logger";
import type { SavantIntent, BackfillProgress } from "../../shared/types";

let activeBackfillAbort: AbortController | null = null;

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CAP = 20; // F6: reduced from 50 — single-user desktop app

/** Ephemeral mood chat sessions keyed by session ID. */
const moodChatSessions = new Map<string, { state: MoodChatState; createdAt: number }>();

/** Ephemeral Savant playlist chat sessions keyed by session ID. */
const savantPlaylistChatSessions = new Map<
  string,
  { state: SavantPlaylistChatState; createdAt: number }
>();

function cleanupChatSessions<T>(
  map: Map<string, { state: T; createdAt: number }>
): void {
  const now = Date.now();
  for (const [id, entry] of map.entries()) {
    if (now - entry.createdAt > SESSION_TTL_MS) map.delete(id);
  }
  while (map.size > SESSION_CAP) {
    const oldest = [...map.entries()].reduce((a, b) =>
      a[1].createdAt < b[1].createdAt ? a : b
    );
    map.delete(oldest[0]);
  }
}

let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic Savant chat-session cleanup (F6). Idempotent — safe to
 * call once during IPC registration.
 */
export function startSavantSessionCleanup(): void {
  if (sessionCleanupTimer) return;
  sessionCleanupTimer = setInterval(() => {
    cleanupChatSessions(moodChatSessions);
    cleanupChatSessions(savantPlaylistChatSessions);
  }, 5 * 60 * 1000);
  // Don't prevent app quit
  sessionCleanupTimer.unref?.();
}

export function registerSavantHandlers(): void {
  ipcMain.handle(
    "savant:generate",
    safe("savant:generate", async (_event, intent: SavantIntent) => {
      const config = getOpenRouterConfig();
      if (!config) return { error: "OpenRouter API key not configured. Add it in Settings." };
      const db = getLibrary().getConnection();
      const core = getPlaylistCore();
      const result = await generateSavantPlaylist(
        intent,
        config,
        db,
        (name, trackIds, savantConfig) =>
          core.createSavantPlaylist(name, trackIds, savantConfig)
      );
      if (result && !("error" in result)) {
        logActivity(
          db,
          "playlist_generated",
          `Savant: ${result.name} (${result.trackCount} tracks)`
        );
      }
      return result;
    })
  );

  ipcMain.handle(
    "savant:checkKeyData",
    safe("savant:checkKeyData", async () => {
      const db = getLibrary().getConnection();
      const keyed = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND camelot IS NOT NULL"
        )
        .get() as { c: number };
      const total = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'"
        )
        .get() as { c: number };
      const bpmOnly = db
        .prepare(
          "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music' AND bpm IS NOT NULL AND camelot IS NULL"
        )
        .get() as { c: number };
      const coveragePct =
        total.c > 0 ? Math.round((keyed.c / total.c) * 100) : 0;
      return {
        keyedCount: keyed.c,
        totalCount: total.c,
        coveragePct,
        bpmOnlyCount: bpmOnly.c,
      };
    })
  );

  ipcMain.handle(
    "savant:backfillFeatures",
    safe("savant:backfillFeatures", async (event, opts?: { percent?: number }) => {
      activeBackfillAbort = new AbortController();
      const signal = activeBackfillAbort.signal;

      const lib = getLibrary();
      const db = lib.getConnection();
      const scanner = new LibraryScanner(db);
      const harmonic = getHarmonicPrefs();

      const sendProgress = (p: BackfillProgress) => {
        event.sender.send("savant:backfillProgress", p);
      };

      try {
        if (harmonic.analyzeWithEssentia) {
          const percent = Math.min(
            100,
            Math.max(1, opts?.percent ?? harmonic.analyzePercent ?? 10)
          );
          const processed = await scanner.backfillFeaturesWithEssentia(
            percent,
            sendProgress,
            signal
          );
          const cancelled = signal.aborted;
          return { processed, cancelled };
        }

        const percent = Math.min(
          100,
          Math.max(1, opts?.percent ?? harmonic.backfillPercent ?? 100)
        );
        const totalMusic = (
          db.prepare(
            "SELECT COUNT(*) as c FROM tracks WHERE content_type = 'music'"
          ).get() as { c: number }
        ).c;
        const maxTracks = Math.max(50, Math.ceil((totalMusic * percent) / 100));
        const processed = await scanner.backfillFeatures(
          maxTracks,
          sendProgress,
          signal
        );
        const cancelled = signal.aborted;
        return { processed, cancelled };
      } finally {
        activeBackfillAbort = null;
      }
    })
  );

  ipcMain.handle(
    "savant:backfillCancel",
    safe("savant:backfillCancel", async () => {
      if (activeBackfillAbort) {
        activeBackfillAbort.abort();
        activeBackfillAbort = null;
      }
    })
  );

  ipcMain.handle(
    "savant:chat:start",
    safe("savant:chat:start", async () => {
      if (!checkRateLimit("savant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const sessionId = randomUUID();
      const db = getLibrary().getConnection();
      const { state, aiMessage } = await startMoodChat(config, db);
      cleanupChatSessions(moodChatSessions);
      moodChatSessions.set(sessionId, { state, createdAt: Date.now() });
      return { sessionId, aiMessage };
    })
  );

  ipcMain.handle(
    "savant:chat:turn",
    safe("savant:chat:turn", async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      if (!checkRateLimit("savant:chat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      cleanupChatSessions(moodChatSessions);
      const entry = moodChatSessions.get(sessionId);
      if (!entry) return { error: "Chat session not found" };
      const db = getLibrary().getConnection();
      const result = await processMoodChatTurn(
        entry.state,
        userMessage,
        config,
        db
      );
      if (result.isComplete) moodChatSessions.delete(sessionId);
      return result;
    })
  );

  ipcMain.handle(
    "savant:chat:skip",
    safe("savant:chat:skip", async (_event, sessionId: string) => {
      moodChatSessions.delete(sessionId);
    })
  );

  ipcMain.handle(
    "savant:playlistChat:start",
    safe("savant:playlistChat:start", async () => {
      if (!checkRateLimit("savant:playlistChat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      const sessionId = randomUUID();
      const db = getLibrary().getConnection();
      const { state, aiMessage } = await startSavantPlaylistChat(config, db);
      cleanupChatSessions(savantPlaylistChatSessions);
      savantPlaylistChatSessions.set(sessionId, { state, createdAt: Date.now() });
      return { sessionId, aiMessage };
    })
  );

  ipcMain.handle(
    "savant:playlistChat:turn",
    safe("savant:playlistChat:turn", async (
      _event,
      { sessionId, userMessage }: { sessionId: string; userMessage: string }
    ) => {
      if (!checkRateLimit("savant:playlistChat"))
        return { error: "Rate limit exceeded. Please wait before sending another message." };
      const config = getOpenRouterConfig();
      if (!config?.apiKey?.trim())
        return { error: "OpenRouter API key not configured" };
      cleanupChatSessions(savantPlaylistChatSessions);
      const entry = savantPlaylistChatSessions.get(sessionId);
      if (!entry) return { error: "Chat session not found" };
      const db = getLibrary().getConnection();
      const result = await processSavantPlaylistChatTurn(
        entry.state,
        userMessage,
        config,
        db
      );
      if (result.isComplete) savantPlaylistChatSessions.delete(sessionId);
      return result;
    })
  );

  ipcMain.handle(
    "savant:playlistChat:skip",
    safe("savant:playlistChat:skip", async (_event, sessionId: string) => {
      savantPlaylistChatSessions.delete(sessionId);
    })
  );
}
