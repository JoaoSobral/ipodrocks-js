import { handle as bridgeHandle } from "../host/bridge";
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
import { denyIfNotOwner } from "../../server/auth/sessions";
import { claimEssentiaJob, releaseEssentiaJob } from "../harmonic/essentia-jobs";
import type { SavantIntent, BackfillProgress } from "../../shared/types";

/**
 * The one backfill that may be running, server-wide.
 *
 * This was a bare `AbortController` overwritten by every call: a second run
 * silently orphaned the first (nothing could cancel it any more), and the
 * first run to finish nulled the slot out from under the newest. Each run is
 * an hours-long, library-wide CPU job, so a second call is refused rather than
 * queued, and `finally` clears the slot only if it still holds *this* run.
 */
let activeBackfill: { abort: AbortController } | null = null;

export const BACKFILL_ALREADY_RUNNING =
  "A harmonic analysis is already running. Wait for it to finish or cancel it first.";
export const OWNER_ONLY_BACKFILL_MESSAGE =
  "Only the server's owner can run or cancel harmonic analysis.";

/**
 * The "analyze on scan" half of Settings → Harmonic Analysis, run as the last
 * phase of every library scan (`runLibraryScan`).
 *
 * The file pass only *reads* key and BPM tags, and skips every file it has
 * seen before. So with "Analyze with Essentia.js" on, a track whose file
 * carries no key tag used to be analysed by nothing but the Backfill button on
 * the Savant tab — while the setting's tooltip promised the scan would do it,
 * and the Library banner told users to "re-scan", which could never help. This
 * analyses the tracks still missing key data — the diff, never the whole
 * library — limited to "Analyze % of library" of them.
 *
 * It takes the same slot and Essentia claim as the Backfill button, so it never
 * runs alongside that or the lossless check: if either is busy it is skipped
 * (the next scan picks the tracks up). The scan's own signal cancels it.
 */
export async function analyzeMissingKeysDuringScan(
  signal: AbortSignal,
  onProgress?: (p: BackfillProgress) => void
): Promise<{ processed: number } | { skipped: string }> {
  const harmonic = getHarmonicPrefs();
  if (!harmonic.scanHarmonicData || !harmonic.analyzeWithEssentia) {
    return { skipped: "Essentia analysis is off" };
  }
  const db = getLibrary().getConnection();
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(camelot IS NULL AND COALESCE(features_scanned, 0) != 2) AS missing
         FROM tracks WHERE content_type = 'music'`
    )
    .get() as { total: number; missing: number | null };
  const missing = counts.missing ?? 0;
  if (missing === 0) return { skipped: "nothing to analyse" };
  if (activeBackfill) return { skipped: BACKFILL_ALREADY_RUNNING };
  const busy = claimEssentiaJob("harmonic analysis");
  if (busy) return { skipped: `the audio analyser is busy with a ${busy}` };
  const run = { abort: new AbortController() };
  activeBackfill = run;
  // Cancelled by the scan's Cancel, or by the Savant tab's backfill cancel.
  const onAbort = () => run.abort.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const share = Math.min(100, Math.max(1, harmonic.analyzePercent ?? 10));
    const target = Math.max(1, Math.ceil((missing * share) / 100));
    // `backfillFeaturesWithEssentia` takes a share of the whole library and
    // samples only tracks without key data, so this asks for exactly `target`.
    const percentOfLibrary = Math.min(100, (target * 100) / counts.total);
    const scanner = new LibraryScanner(db);
    const processed = await scanner.backfillFeaturesWithEssentia(
      percentOfLibrary,
      onProgress,
      run.abort.signal
    );
    return { processed };
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (activeBackfill === run) {
      activeBackfill = null;
      releaseEssentiaJob("harmonic analysis");
    }
  }
}

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
  bridgeHandle(
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

  bridgeHandle(
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

  bridgeHandle(
    "savant:backfillFeatures",
    safe("savant:backfillFeatures", async (event, opts?: { percent?: number }) => {
      // Library-wide and CPU-bound: one user's run is every user's wait. The
      // owner decides when that happens; everyone else is refused here, and
      // `sessionId === undefined` (the desktop window) is the owner by
      // definition.
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_BACKFILL_MESSAGE);
      if (denied) return denied;
      if (activeBackfill) return { error: BACKFILL_ALREADY_RUNNING };
      const busy = claimEssentiaJob("harmonic analysis");
      if (busy) return { error: `A ${busy} is using the audio analyser. Wait for it to finish or cancel it first.` };
      const run = { abort: new AbortController() };
      activeBackfill = run;
      const signal = run.abort.signal;

      // Everything after taking the slot is inside the try, so nothing that
      // throws can leave it held for good.
      try {
        const lib = getLibrary();
        const db = lib.getConnection();
        const scanner = new LibraryScanner(db);
        const harmonic = getHarmonicPrefs();

        const sendProgress = (p: BackfillProgress) => {
          event.sender.send("savant:backfillProgress", p);
        };

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
        if (activeBackfill === run) {
          activeBackfill = null;
          releaseEssentiaJob("harmonic analysis");
        }
      }
    })
  );

  bridgeHandle(
    "savant:backfillCancel",
    safe("savant:backfillCancel", async (event) => {
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_BACKFILL_MESSAGE);
      if (denied) return denied;
      // The slot is left for the run's own `finally` to clear: clearing it
      // here would admit a second run while the first is still winding down
      // its in-flight track.
      activeBackfill?.abort.abort();
      return undefined;
    })
  );

  bridgeHandle(
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

  bridgeHandle(
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

  bridgeHandle(
    "savant:chat:skip",
    safe("savant:chat:skip", async (_event, sessionId: string) => {
      moodChatSessions.delete(sessionId);
    })
  );

  bridgeHandle(
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

  bridgeHandle(
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

  bridgeHandle(
    "savant:playlistChat:skip",
    safe("savant:playlistChat:skip", async (_event, sessionId: string) => {
      savantPlaylistChatSessions.delete(sessionId);
    })
  );
}
