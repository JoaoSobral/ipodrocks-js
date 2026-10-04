import { useEffect, useRef, useState, useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  InflightFile,
  SyncOptions,
  SyncProgress,
  SyncStatusSnapshot,
  SyncWaitKind,
} from "@shared/types";
import { startSync, cancelSync, onSyncProgress, getSyncStatus } from "@renderer/ipc/api";
import { getWebTransport, isWebMode } from "@renderer/ipc/web-transport";
import { useKeepTabAlive } from "@renderer/device/keep-alive";
import { getDeviceClient } from "@renderer/device";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ProgressBar } from "../common/ProgressBar";
import { ErrorBox } from "../common/ErrorBox";

interface RecentItem {
  id: number;
  path: string;
  event: string;
  status: SyncProgress["status"];
}

/**
 * One line of the Progress box: either something the sync said ("Comparing
 * library with device…") or a file that finished. Both used to exist, but only
 * the files were rendered — so for the whole of a long preparing phase, and
 * until the first file of a slow copy landed, the box said "Preparing…" while
 * the sync was busily explaining itself into a list nobody could see.
 */
type FeedInput =
  | { kind: "log"; text: string }
  | { kind: "file"; path: string; event: string; status: SyncProgress["status"] };
type FeedEntry = FeedInput & { id: number };

export interface SyncCompleteResult {
  synced: number;
  /** Track/song-data failures only. Album artwork is counted separately. */
  errors: number;
  skipped: number;
  /** Album-artwork failures. Never song data — cover art only. */
  artworkErrors: number;
  status: "success" | "error" | "warning";
  skippedBreakdown: {
    music: number;
    podcast: number;
    audiobook: number;
    artwork: number;
    playlist: number;
  };
}

interface SyncProgressModalProps {
  open: boolean;
  onClose: () => void;
  syncOptions: SyncOptions;
  onComplete?: (result: SyncCompleteResult) => void;
  /**
   * Re-join a sync that is already running on `syncOptions.deviceId` — after a
   * page reload, say — instead of starting one. Progress resumes from the
   * server's `sync:status` snapshot.
   */
  rejoin?: boolean;
}

/** The window the transfer rate is averaged over. */
const RATE_WINDOW_MS = 5000;
/** How often a re-joined modal asks whether the sync has finished. */
const REJOIN_POLL_MS = 3000;

/** "850 KB/s", "12.4 MB/s". */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(0, Math.round(bytesPerSec / 1024))} KB/s`;
}

/** "640 MB", "1.2 GB". */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return "<1 min left";
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min left`;
  return `~${(seconds / 3600).toFixed(1)} h left`;
}

const statusIcon: Record<string, string> = {
  copied: "✅",
  converted: "✅",
  skipped: "⏭️",
  skip: "⏭️",
  error: "❌",
  remove: "🗑️",
  missing: "⏭️",
};

function itemStatusIcon(status: string | undefined, event: string): string {
  return statusIcon[String(status)] ?? statusIcon[event] ?? "⏭️";
}

/** Filename for display (Windows and POSIX paths). */
function pathBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

type LogEntry = { id: number; text: string };

function appendCappedLog(
  setter: Dispatch<SetStateAction<LogEntry[]>>,
  idRef: MutableRefObject<number>,
  text: string,
  cap: number,
) {
  setter((prev) => {
    const next = [...prev, { id: ++idRef.current, text }];
    return next.length > cap ? next.slice(-cap) : next;
  });
}

const LOG_BUFFER_CAP = 200;
/** Lines kept in the Progress box. */
const FEED_CAP = 200;

const EMPTY_SKIP_BREAKDOWN = {
  music: 0,
  podcast: 0,
  audiobook: 0,
  artwork: 0,
  playlist: 0,
} as const;

type SyncResult = {
  synced?: number;
  removed?: number;
  errors?: number;
  artworkErrors?: number;
  error?: string;
};

/**
 * Follows a sync this tab did not start (or no longer holds the request for)
 * until it finishes, feeding each `sync:status` snapshot to `onSnapshot`.
 * Resolves with the sync's own result, exactly as `startSync()` would have.
 */
async function waitForRunningSync(
  deviceId: number,
  onSnapshot: (snap: SyncStatusSnapshot) => void
): Promise<SyncResult> {
  for (;;) {
    const snap = (await getSyncStatus(deviceId)).find((s) => s.deviceId === deviceId);
    if (!snap) return { error: "That sync is no longer running." };
    onSnapshot(snap);
    if (!snap.active) return (snap.result as SyncResult) ?? {};
    await new Promise((resolve) => setTimeout(resolve, REJOIN_POLL_MS));
  }
}

export function SyncProgressModal({
  open,
  onClose,
  syncOptions,
  onComplete,
  rejoin = false,
}: SyncProgressModalProps) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  /** Files on their way right now, by source path. */
  const [inflight, setInflight] = useState<Map<string, InflightFile>>(() => new Map());
  /** What the direct copies will move in all; 0 when unknown (transcodes). */
  const [totalBytes, setTotalBytes] = useState(0);
  const [statusMessages, setStatusMessages] = useState<LogEntry[]>([]);
  const [logLines, setLogLines] = useState<LogEntry[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [processedItems, setProcessedItems] = useState(0);
  const [copiedItems, setCopiedItems] = useState(0);
  const [skippedByType, setSkippedByType] = useState({ ...EMPTY_SKIP_BREAKDOWN });
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  /** Album-artwork failures, reported apart from song-data failures. */
  const [artworkErrors, setArtworkErrors] = useState(0);
  /**
   * What `sync:start` itself said it copied, which is the authoritative number.
   *
   * The progress frames are advisory: they travel `webContents.send`, while the
   * result comes back on the `invoke` reply, and Electron does not order the two
   * against each other. A sync short enough to finish in a few hundred
   * milliseconds routinely has its reply overtake its own frames — see the
   * comment on the subscription effect below.
   */
  const [reportedSynced, setReportedSynced] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  /** Bytes put on the device so far, and the rolling rate over them. */
  const [bytesTotal, setBytesTotal] = useState(0);
  const [rate, setRate] = useState(0);
  /** `waiting` while the link to the device is down. */
  const [waitingReason, setWaitingReason] = useState<string | null>(null);
  /** Set while the *device* (not the link) is gone, so the banner can offer Reconnect. */
  const [waitKind, setWaitKind] = useState<SyncWaitKind | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const bytesTotalRef = useRef(0);
  const rateSamplesRef = useRef<{ t: number; total: number }[]>([]);

  const listRef = useRef<HTMLDivElement>(null);
  const feedIdRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const itemIdRef = useRef(0);
  const logIdRef = useRef(0);
  const statusIdRef = useRef(0);
  const elapsedInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncStartedRef = useRef(false);
  const progressUnsubRef = useRef<(() => void) | null>(null);
  const hasReceivedTotalRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  /** Mirrors progress counters for use in startSync().then — React state in that closure would be stale. */
  const processedItemsRef = useRef(0);
  const copiedItemsRef = useRef(0);
  const skippedByTypeRef = useRef({ ...EMPTY_SKIP_BREAKDOWN });
  onCompleteRef.current = onComplete;

  const isRunning = !finished && !error;
  /**
   * The summary numbers, reconciled.
   *
   * `processedItems`/`copiedItems` come from progress frames and are richer —
   * they distinguish skipped from copied and break skips down by content type.
   * But they can be *absent*, because a short sync's `invoke` reply can arrive
   * before its own frames. So a finished sync whose result says it copied
   * something is never rendered as though nothing happened.
   */
  const summaryCopied = Math.max(copiedItems, reportedSynced ?? 0);
  const summaryProcessed = Math.max(processedItems, summaryCopied);
  const didSomething = summaryProcessed > 0;
  // Bytes when the total is known (direct copies), so the bar moves as data
  // does; a count-based bar sits at 0% until the first whole file lands, which
  // on a slow link is long enough to read as a hung sync. Never behind the
  // count, which also covers artwork and playlists the byte total does not.
  const countPct = totalItems > 0 ? (processedItems / totalItems) * 100 : 0;
  const bytePct = totalBytes > 0 ? (bytesTotal / totalBytes) * 100 : 0;
  const rawPct = Math.round(Math.max(countPct, bytePct));
  // On a clean finish the bar should read 100% even when the backend's pre-count
  // (totalItems) ended up higher than the number of items actually copied.
  const pct = finished && !error && !cancelled ? 100 : Math.min(rawPct, 100);

  const pushFeed = useCallback((entry: FeedInput) => {
    setFeed((prev) => {
      const next: FeedEntry[] = [...prev, { ...entry, id: ++feedIdRef.current }];
      return next.length > FEED_CAP ? next.slice(-FEED_CAP) : next;
    });
  }, []);

  const handleProgress = useCallback((p: SyncProgress) => {
    if (p.event === "copy_start") {
      setInflight((prev) => {
        const next = new Map(prev);
        next.set(p.path, { path: p.path, done: 0, total: p.bytes ?? null });
        return next;
      });
      return;
    }

    if (p.event === "total_bytes") {
      setTotalBytes((n) => n + (Number(p.bytes) || 0));
      return;
    }

    if (p.event === "bytes") {
      if (Array.isArray(p.inflight)) {
        // The server's view of what is in flight is complete, so it replaces
        // ours rather than merging — a file whose `copy` frame was lost does
        // not linger as "copying" for ever.
        setInflight(new Map(p.inflight.map((f) => [f.path, f])));
      }
      const total = bytesTotalRef.current + (Number(p.bytes) || 0);
      bytesTotalRef.current = total;
      setBytesTotal(total);
      const now = Date.now();
      const samples = rateSamplesRef.current;
      samples.push({ t: now, total });
      while (samples.length > 2 && now - samples[0].t > RATE_WINDOW_MS) samples.shift();
      const first = samples[0];
      const span = (now - first.t) / 1000;
      if (span > 0.5) setRate((total - first.total) / span);
      return;
    }

    if (p.event === "state") {
      setWaitingReason(p.state === "waiting" ? (p.message ?? "Waiting for the device…") : null);
      setWaitKind(p.state === "waiting" ? (p.waitKind ?? null) : null);
      if (p.message) {
        appendCappedLog(setStatusMessages, statusIdRef, p.message, LOG_BUFFER_CAP);
        pushFeed({ kind: "log", text: p.message });
      }
      return;
    }

    setProgress(p);

    if (p.event === "log") {
      const text = p.message ?? p.path ?? "";
      appendCappedLog(setStatusMessages, statusIdRef, text, LOG_BUFFER_CAP);
      if (text) pushFeed({ kind: "log", text });
      return;
    }

    if (p.event === "convert_log") {
      appendCappedLog(setLogLines, logIdRef, p.message ?? p.path ?? "", LOG_BUFFER_CAP);
      return;
    }

    if (p.event === "total" || p.event === "total_add") {
      hasReceivedTotalRef.current = true;
      const count = Number(p.path) || 0;
      setTotalItems((prev) => prev + count);
      return;
    }

    if (p.event === "copy") {
      setInflight((prev) => {
        if (!prev.has(p.path)) return prev;
        const next = new Map(prev);
        next.delete(p.path);
        return next;
      });
      pushFeed({ kind: "file", path: p.path, event: p.event, status: p.status });
      setProcessedItems((n) => {
        const next = n + 1;
        processedItemsRef.current = next;
        return next;
      });
      const status = String(p.status);
      const contentType = (p.contentType as string) || "unknown";
      if (status === "copied" || status === "converted") {
        setCopiedItems((n) => {
          const next = n + 1;
          copiedItemsRef.current = next;
          return next;
        });
      } else if (status === "skipped") {
        setSkippedByType((prev) => {
          const key = contentType as keyof typeof prev;
          const next = key in prev ? { ...prev, [key]: prev[key] + 1 } : prev;
          skippedByTypeRef.current = next;
          return next;
        });
      }
      setRecentItems((prev) => {
        const next = [...prev, { id: ++itemIdRef.current, path: p.path, event: p.event, status: p.status }];
        return next.length > 30 ? next.slice(-30) : next;
      });
    }

    if (p.status === "complete") setFinished(true);
    if (p.status === "cancelled") {
      setCancelled(true);
      setFinished(true);
    }
    // Only a sync-level failure fills the error box. A file or album that
    // failed is already a ✕ line — putting its path in the box made one bad
    // album read as "the sync failed: /media/music/Parcels/Parcels".
    if (p.status === "error" && p.event !== "copy") {
      setError(p.message || p.path || "Sync failed");
    }
  }, [pushFeed]);

  useEffect(() => {
    if (finished && elapsedInterval.current) {
      clearInterval(elapsedInterval.current);
      elapsedInterval.current = null;
    }
  }, [finished]);

  /**
   * Listen for as long as the modal is open — **not** until `sync:start`
   * resolves.
   *
   * This used to be part of the effect below, subscribing just before
   * `startSync()` and unsubscribing in its `.finally()`. That looks airtight
   * and is not: progress frames arrive by `webContents.send` while the result
   * arrives on the `invoke` reply, and Electron gives no ordering guarantee
   * between the two. On a sync of a handful of files the reply reliably
   * overtakes the frames, so the modal tore its listener down after the first
   * one and rendered "Nothing to sync — device up to date." over a sync that
   * had just copied the user's whole selection.
   *
   * Keeping it in its own effect also fixes the leak the old shape had: the
   * `!open` branch never ran, because `SyncPanel` unmounts the modal in the
   * same commit that sets `open` false.
   */
  useEffect(() => {
    if (!open) return;
    const unsub = onSyncProgress(handleProgress);
    progressUnsubRef.current = unsub;
    return () => {
      unsub();
      progressUnsubRef.current = null;
    };
  }, [open, handleProgress]);

  useEffect(() => {
    if (!open) {
      syncStartedRef.current = false;
      hasReceivedTotalRef.current = false;
      return;
    }
    if (syncStartedRef.current) return;
    syncStartedRef.current = true;

    setProgress(null);
    setRecentItems([]);
    setFeed([]);
    setInflight(new Map());
    setTotalBytes(0);
    setStatusMessages([]);
    setLogLines([]);
    setTotalItems(0);
    setProcessedItems(0);
    setCopiedItems(0);
    const zeroSkip = { ...EMPTY_SKIP_BREAKDOWN };
    setSkippedByType(zeroSkip);
    skippedByTypeRef.current = { ...zeroSkip };
    processedItemsRef.current = 0;
    copiedItemsRef.current = 0;
    setFinished(false);
    setError(null);
    setCancelled(false);
    setArtworkErrors(0);
    setReportedSynced(null);
    setElapsedSec(0);
    hasReceivedTotalRef.current = false;

    setBytesTotal(0);
    setRate(0);
    setWaitingReason(null);
    setWaitKind(null);
    bytesTotalRef.current = 0;
    rateSamplesRef.current = [];

    elapsedInterval.current = setInterval(() => {
      setElapsedSec((s) => s + 1);
      // A rate with no fresh samples is a stalled transfer, not the last
      // speed it happened to have.
      const samples = rateSamplesRef.current;
      if (samples.length > 0 && Date.now() - samples[samples.length - 1].t > RATE_WINDOW_MS) {
        setRate(0);
      }
    }, 1000);

    const opts = syncOptions;

    const run: Promise<SyncResult> =
      rejoin ? waitForRunningSync(opts.deviceId, applySnapshot) : startSync(opts);

    run
      .then((result: { synced?: number; removed?: number; errors?: number; artworkErrors?: number; error?: string }) => {
        setFinished(true);
        const errMsg = result?.error != null ? String(result.error) : "";
        const isCancelled = errMsg.toLowerCase().includes("cancelled");
        if (isCancelled) {
          setCancelled(true);
        } else if (errMsg) {
          setError(errMsg);
        }
        const synced = result?.synced ?? 0;
        setReportedSynced(synced);
        const errors = result?.errors ?? 0;
        const artworkErrors = isCancelled ? 0 : result?.artworkErrors ?? 0;
        const totalSkipped = processedItemsRef.current - copiedItemsRef.current;
        setArtworkErrors(artworkErrors);

        // Artwork failures fail the sync, but they are cover art only — never
        // song data — so they get their own count and their own wording.
        const status: SyncCompleteResult["status"] = isCancelled
          ? "warning"
          : errors > 0
            ? synced > 0
              ? "warning"
              : "error"
            : artworkErrors > 0
              ? "error"
              : "success";

        onCompleteRef.current?.({
          synced,
          skipped: totalSkipped,
          errors: isCancelled ? 0 : errors || (errMsg ? 1 : 0),
          artworkErrors,
          status,
          skippedBreakdown: { ...skippedByTypeRef.current },
        });
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        const isCancelled = msg.toLowerCase().includes("cancelled");
        if (isCancelled) {
          setCancelled(true);
          setFinished(true);
        } else {
          setError(msg);
        }
        onCompleteRef.current?.({
          synced: 0,
          skipped: 0,
          errors: isCancelled ? 0 : 1,
          artworkErrors: 0,
          status: "error",
          skippedBreakdown: { ...skippedByTypeRef.current },
        });
      })
      .finally(() => {
        // Deliberately does not unsubscribe: frames for this very sync may
        // still be in flight behind the reply.
        syncStartedRef.current = false;
      });

    return () => {
      if (elapsedInterval.current) {
        clearInterval(elapsedInterval.current);
        elapsedInterval.current = null;
      }
    };
    // Only run when open toggles; syncOptions captured at start to avoid restart/reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * Adopt the server's counters. Used when re-joining, and after a reconnect
   * whose missed frames could not be replayed — either way the live frames
   * alone would leave the counts short.
   */
  function applySnapshot(snap: SyncStatusSnapshot): void {
    hasReceivedTotalRef.current = snap.total > 0 || hasReceivedTotalRef.current;
    setTotalItems(snap.total);
    setProcessedItems(snap.processed);
    processedItemsRef.current = snap.processed;
    setCopiedItems(snap.synced);
    copiedItemsRef.current = snap.synced;
    bytesTotalRef.current = snap.bytes;
    setBytesTotal(snap.bytes);
    setTotalBytes(snap.totalBytes ?? 0);
    setInflight(new Map((snap.inflight ?? []).map((f) => [f.path, f])));
    setWaitingReason(snap.state === "waiting" ? (snap.reason ?? "Waiting for the device…") : null);
    setWaitKind(snap.state === "waiting" ? (snap.waitKind ?? null) : null);
    if (snap.log.length > 0) {
      setStatusMessages(snap.log.map((text) => ({ id: ++statusIdRef.current, text })));
      // A rejoined modal has no file history to show, but it can show what the
      // sync has been saying.
      setFeed(snap.log.map((text) => ({ id: ++feedIdRef.current, kind: "log" as const, text })));
    }
  }

  // Frames lost beyond what the server could replay: re-read the counters.
  useEffect(() => {
    if (!open || !isWebMode()) return;
    const transport = getWebTransport();
    if (!transport) return;
    return transport.onResync(() => {
      void getSyncStatus(syncOptions.deviceId).then((snaps) => {
        const snap = snaps.find((s) => s.deviceId === syncOptions.deviceId);
        if (snap) applySnapshot(snap);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, syncOptions.deviceId]);

  useKeepTabAlive(open && isRunning && isWebMode(), `sync-${syncOptions.deviceId}`);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [feed]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const handleCancel = async () => {
    try {
      await cancelSync(syncOptions.deviceId);
      setCancelled(true);
      setFinished(true);
    } catch {
      // ignore
    }
  };

  const handleCopyLog = () => {
    const lines: string[] = [
      "=== Sync progress ===",
      `${processedItems} / ${totalItems || "?"} items, ${copiedItems} copied`,
      ...statusMessages.map((s) => s.text),
      "",
      "=== Recent files ===",
      ...recentItems.map((r) => `[${r.status ?? r.event}] ${r.path}`),
      "",
      "=== Conversion log ===",
      ...logLines.map((l) => l.text),
    ];
    const text = lines.join("\n");
    void navigator.clipboard.writeText(text);
  };

  const variant = finished
    ? cancelled ? "default" : "success"
    : error ? "error" : "default";

  return (
    <Modal
        open={open}
        onClose={isRunning ? () => {} : onClose}
        title="Syncing to Device"
        width="max-w-2xl"
      >
      <div className="flex flex-col gap-4">
        <ProgressBar value={pct} showPercent variant={variant} />

        {!finished && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate max-w-[50%]">
              {progress?.event === "log" && progress?.message
                ? progress.message
                : inflight.size > 0
                  ? `Copying ${pathBasename([...inflight.keys()][inflight.size - 1])}`
                  : progress?.path
                    ? pathBasename(progress.path)
                    : "Preparing…"}
            </span>
            <div className="flex gap-4 tabular-nums shrink-0">
              <span className="text-success font-medium">{copiedItems} / {totalItems || "?"} copied</span>
              <span>{processedItems} processed</span>
              <span className="text-muted-foreground">{Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, "0")} elapsed</span>
            </div>
          </div>
        )}

        {!finished && bytesTotal > 0 && (
          <div
            className="flex items-center justify-between text-xs text-muted-foreground tabular-nums"
            data-testid="sync-rate"
          >
            <span>{formatBytes(bytesTotal)} transferred</span>
            <span>
              {formatRate(rate)}
              {rate > 0 && totalBytes > bytesTotal
                ? ` · ${formatEta((totalBytes - bytesTotal) / rate)}`
                : rate > 0 && copiedItems > 0 && totalItems > processedItems
                  ? ` · ${formatEta(
                      ((totalItems - processedItems) * (bytesTotal / copiedItems)) / rate
                    )}`
                  : ""}
            </span>
          </div>
        )}

        {!finished && waitingReason && (
          <div
            role="status"
            data-testid="sync-waiting"
            className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            {waitingReason}
            {waitKind === "unplugged" && isWebMode() && (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={reconnecting}
                  data-testid="sync-reconnect-device"
                  onClick={() => {
                    // Straight from the click: both the permission prompt and
                    // the folder picker need a user gesture.
                    const client = getDeviceClient();
                    if (!client) return;
                    setReconnecting(true);
                    void client
                      .restore(syncOptions.deviceId, { prompt: true })
                      .then((ok) => (ok ? undefined : client.pickAndAttach(syncOptions.deviceId)))
                      .finally(() => setReconnecting(false));
                  }}
                >
                  {reconnecting ? "Reconnecting…" : "Reconnect iPod"}
                </Button>
                <span className="text-muted-foreground">
                  If it doesn&apos;t resume by itself once plugged in, press Reconnect and pick
                  the same folder.
                </span>
              </div>
            )}
          </div>
        )}

        {!finished && inflight.size > 0 && (
          <div className="flex flex-col gap-1.5" data-testid="sync-inflight">
            <span className="text-xs font-medium text-muted-foreground">In progress</span>
            {[...inflight.values()].map((f) => (
              <div key={f.path} className="text-xs" data-testid="sync-inflight-file">
                <div className="flex justify-between gap-2 text-muted-foreground">
                  <span className="truncate">⏳ {pathBasename(f.path)}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatBytes(f.done)}
                    {f.total != null ? ` / ${formatBytes(f.total)}` : ""}
                  </span>
                </div>
                {f.total != null && f.total > 0 && (
                  <div className="mt-0.5 h-1 rounded bg-muted">
                    <div
                      className="h-1 rounded bg-primary/60"
                      style={{ width: `${Math.min(100, (f.done / f.total) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Recent items */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Progress</span>
          <button
            type="button"
            onClick={handleCopyLog}
            className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1"
            title="Copy full log to clipboard"
          >
            📋 Copy log
          </button>
        </div>
        <div
          ref={listRef}
          className="h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono"
        >
          {feed.length === 0 && !finished && (
            <p className="text-muted-foreground">
              {hasReceivedTotalRef.current && totalItems > 0
                ? "Preparing files for sync…"
                : "Waiting for sync…"}
            </p>
          )}
          {feed.map((item) =>
            item.kind === "log" ? (
              <div
                key={item.id}
                className="py-0.5 text-muted-foreground/80 whitespace-pre-wrap break-words"
                data-testid="sync-feed-log"
              >
                {item.text}
              </div>
            ) : (
              <div
                key={item.id}
                className="flex items-start gap-2 py-0.5 text-muted-foreground"
                data-testid="sync-feed-file"
              >
                <span className="shrink-0">{itemStatusIcon(item.status, item.event)}</span>
                <span className="truncate">{item.path}</span>
              </div>
            )
          )}
          {/* The verdict, when no per-file line says it already. After the
              feed rather than instead of it: the phase lines stay readable. */}
          {finished && !feed.some((f) => f.kind === "file") && (
            <p className="text-sm font-bold text-foreground pt-1">
              {cancelled
                ? "Sync was cancelled."
                : didSomething
                  ? // The per-file lines never arrived, but the sync itself
                    // reported what it did. Saying "nothing to sync" here is
                    // the one wrong answer: it reads as data loss to anyone
                    // who just watched an album go across.
                    `Synced ${summaryCopied} item${summaryCopied === 1 ? "" : "s"}.`
                  : "Nothing to sync — device up to date."}
            </p>
          )}
        </div>

        {/* Conversion log */}
        {logLines.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Conversion Log</span>
            <div
              ref={logRef}
              className="h-28 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono text-muted-foreground"
            >
              {logLines.map((entry) => (
                <div key={entry.id} className="py-0.5">{entry.text}</div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <ErrorBox>{error}</ErrorBox>
        )}

        {finished && !error && didSomething && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">{summaryProcessed}</p>
                <p className="text-xs text-muted-foreground">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">{summaryCopied}</p>
                <p className="text-xs text-muted-foreground">Copied</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">{summaryProcessed - summaryCopied}</p>
                <p className="text-xs text-muted-foreground">Skipped</p>
              </div>
            </div>
            {(skippedByType.music > 0 || skippedByType.podcast > 0 || skippedByType.audiobook > 0 || skippedByType.artwork > 0 || skippedByType.playlist > 0) && (
              <div className="mt-2 text-xs text-muted-foreground text-center">
                Skipped: {[
                  skippedByType.music > 0 && `${skippedByType.music} songs`,
                  skippedByType.podcast > 0 && `${skippedByType.podcast} podcasts`,
                  skippedByType.audiobook > 0 && `${skippedByType.audiobook} audiobooks`,
                  skippedByType.artwork > 0 && `${skippedByType.artwork} artwork`,
                  skippedByType.playlist > 0 && `${skippedByType.playlist} playlists`,
                ].filter(Boolean).join(", ")}
              </div>
            )}
            {artworkErrors > 0 && (
              <p className="mt-2 text-center text-xs font-medium text-destructive">
                Album artwork failed for {artworkErrors} album{artworkErrors === 1 ? "" : "s"} — cover
                art only. Your song files copied successfully.
              </p>
            )}
            {cancelled && (
              <p className="mt-2 text-center text-xs text-warning">Sync was cancelled</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {isRunning ? (
            <Button variant="danger" size="sm" onClick={handleCancel}>
              Cancel Sync
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
