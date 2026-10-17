import { handle as bridgeHandle } from "../host/bridge";
import { safe, getLibrary } from "./common";
import { getHostShell } from "../host";
import { denyIfNotOwner } from "../../server/auth/sessions";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import { claimEssentiaJob, releaseEssentiaJob } from "../harmonic/essentia-jobs";
import {
  clearLosslessVerdicts,
  getLosslessReport,
  runLosslessScan,
  setLosslessOverride,
} from "../lossless/lossless-scan";
import { deleteFlaggedLosslessTracks } from "../lossless/lossless-delete";
import { isLibraryScanActive, reconcilePlaylistsAfterLibraryChange } from "./library";
import {
  LOSSLESS_VERDICT_LABELS,
  type LosslessDeleteResult,
  type LosslessProgress,
  type LosslessScanOptions,
  type LosslessScanResult,
  type LosslessVerdict,
} from "../../shared/types";

/**
 * The one lossless check that may be running, server-wide — the same
 * single-slot shape as the harmonic backfill (`ipc/savant.ts`): a second start
 * is refused, and `finally` clears the slot only if it still holds this run.
 */
interface CheckRun {
  abort: AbortController;
  progress: LosslessProgress | null;
}
let activeCheck: CheckRun | null = null;
/** The last finished run, so a client that looked away can still read the outcome. */
let lastResult: LosslessScanResult | null = null;

export const LOSSLESS_CHECK_RUNNING =
  "A lossless check is already running. Wait for it to finish or cancel it first.";
export const OWNER_ONLY_LOSSLESS_MESSAGE =
  "Only the server's owner can run the lossless check or change its results.";
export const OWNER_ONLY_LOSSLESS_DELETE_MESSAGE =
  "Only the server's owner can delete files from the library.";

export function isLosslessCheckActive(): boolean {
  return activeCheck !== null;
}

const VERDICTS = new Set<LosslessVerdict>(Object.keys(LOSSLESS_VERDICT_LABELS) as LosslessVerdict[]);

function sanitizeIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is number => Number.isInteger(id) && id > 0);
}

/**
 * Run the check. `send` receives progress. Shared by the channel and Rocksy's
 * `lossless_scan`, so the two cannot drift; callers apply the owner gate.
 */
export async function startLosslessCheck(
  opts: LosslessScanOptions | undefined,
  send: (p: LosslessProgress) => void
): Promise<LosslessScanResult | { error: string }> {
  if (activeCheck) return { error: LOSSLESS_CHECK_RUNNING };
  const busy = claimEssentiaJob("lossless check");
  if (busy) return { error: `A ${busy} is using the audio analyser. Wait for it to finish or cancel it first.` };
  const run: CheckRun = { abort: new AbortController(), progress: null };
  activeCheck = run;
  try {
    const scope = opts?.scope === "all" ? "all" : "unchecked";
    const db = getLibrary().getConnection();
    // The check runs on the main process (decode in ffmpeg, Essentia on its
    // worker thread) independently of any window: the modal can be closed,
    // the app used, the window minimised. `lossless:status` hands the latest
    // progress to whatever re-opens it.
    const result = await runLosslessScan(
      db,
      { scope, deep: opts?.deep !== false },
      (p) => {
        run.progress = p;
        send(p);
      },
      run.abort.signal
    );
    lastResult = result;
    const flagged =
      (result.counts.lossy_strong ?? 0) +
      (result.counts.lossy ?? 0) +
      (result.counts.upsampled ?? 0) +
      (result.counts.possibly_lossy ?? 0);
    logActivity(
      db,
      "lossless_check",
      `Lossless check: ${result.checked} checked, ${flagged} flagged${result.cancelled ? " (cancelled)" : ""}`
    );
    invalidateAssistantCache();
    return result;
  } finally {
    if (activeCheck === run) {
      activeCheck = null;
      releaseEssentiaJob("lossless check");
    }
  }
}

/** Delete flagged files and clean up after them. Callers apply the owner gate. */
export async function deleteLosslessFlagged(trackIds: number[]): Promise<LosslessDeleteResult | { error: string }> {
  if (activeCheck) return { error: "Wait for the lossless check to finish before deleting files." };
  if (isLibraryScanActive()) return { error: "Wait for the library scan to finish before deleting files." };
  const lib = getLibrary();
  const db = lib.getConnection();
  const outcome = await deleteFlaggedLosslessTracks(db, trackIds);
  if (outcome.removedTrackIds.length > 0 || outcome.removedShadowPaths.length > 0) {
    lib
      .propagateScanToShadows([], [], outcome.removedTrackIds, undefined, outcome.removedShadowPaths)
      .catch((err) => console.error("[ipc] Shadow propagation after lossless delete:", err));
    reconcilePlaylistsAfterLibraryChange("lossless delete");
  }
  logActivity(
    db,
    "lossless_delete",
    `Deleted ${outcome.deleted} lossy-sourced file(s): ${outcome.trashed} to trash, ${outcome.permanent} permanently` +
      (outcome.failed.length ? `, ${outcome.failed.length} failed` : "")
  );
  invalidateAssistantCache();
  const { deleted, trashed, permanent, failed } = outcome;
  return { deleted, trashed, permanent, failed };
}

export function registerLosslessHandlers(): void {
  bridgeHandle(
    "lossless:scan",
    safe("lossless:scan", async (event, opts?: LosslessScanOptions) => {
      // Library-wide and CPU-bound, like the harmonic backfill: the owner decides.
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_LOSSLESS_MESSAGE);
      if (denied) return denied;
      return startLosslessCheck(opts, (p) => event.sender.send("lossless:progress", p));
    })
  );

  bridgeHandle(
    "lossless:cancel",
    safe("lossless:cancel", async (event) => {
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_LOSSLESS_MESSAGE);
      if (denied) return denied;
      // The run's own `finally` releases the slot.
      activeCheck?.abort.abort();
      return { cancelled: activeCheck !== null };
    })
  );

  bridgeHandle(
    "lossless:status",
    safe("lossless:status", async () => ({
      running: activeCheck !== null,
      progress: activeCheck?.progress ?? null,
      lastResult,
    }))
  );

  bridgeHandle(
    "lossless:report",
    safe("lossless:report", async (_event, opts?: { verdicts?: LosslessVerdict[] }) => {
      const verdicts = Array.isArray(opts?.verdicts)
        ? opts.verdicts.filter((v): v is LosslessVerdict => VERDICTS.has(v))
        : undefined;
      return getLosslessReport(getLibrary().getConnection(), verdicts);
    })
  );

  bridgeHandle(
    "lossless:setOverride",
    safe("lossless:setOverride", async (event, payload?: { trackIds?: number[]; ok?: boolean }) => {
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_LOSSLESS_MESSAGE);
      if (denied) return denied;
      const changed = setLosslessOverride(getLibrary().getConnection(), sanitizeIds(payload?.trackIds), payload?.ok !== false);
      return { changed };
    })
  );

  bridgeHandle(
    "lossless:clear",
    safe("lossless:clear", async (event, payload?: { trackIds?: number[] }) => {
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_LOSSLESS_MESSAGE);
      if (denied) return denied;
      if (activeCheck) return { error: LOSSLESS_CHECK_RUNNING };
      const ids = payload?.trackIds === undefined ? undefined : sanitizeIds(payload.trackIds);
      return { cleared: clearLosslessVerdicts(getLibrary().getConnection(), ids) };
    })
  );

  bridgeHandle(
    "lossless:deleteFlagged",
    safe("lossless:deleteFlagged", async (event, payload?: { trackIds?: number[] }) => {
      const denied = denyIfNotOwner(event.sessionId, OWNER_ONLY_LOSSLESS_DELETE_MESSAGE);
      if (denied) return denied;
      return deleteLosslessFlagged(sanitizeIds(payload?.trackIds));
    })
  );

  bridgeHandle(
    "lossless:hostHasTrash",
    // The *host's* trash: a desktop-hosted server trashes a web caller's
    // deletes too, while the headless daemon has none and deletes permanently.
    safe("lossless:hostHasTrash", async () => ({ hasTrash: getHostShell().hasTrash }))
  );
}
