import { useEffect, useRef, useState, useCallback } from "react";
import type { SyncOptions, SyncProgress } from "@shared/types";
import { startSync, cancelSync, onSyncProgress } from "@renderer/ipc/api";
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

export interface SyncCompleteResult {
  synced: number;
  skipped: number;
  errors: number;
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

export function SyncProgressModal({
  open,
  onClose,
  syncOptions,
  onComplete,
}: SyncProgressModalProps) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [logLines, setLogLines] = useState<{ id: number; text: string }[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [processedItems, setProcessedItems] = useState(0);
  const [copiedItems, setCopiedItems] = useState(0);
  const [skippedByType, setSkippedByType] = useState({
    music: 0, podcast: 0, audiobook: 0, artwork: 0, playlist: 0,
  });
  const [copiedByType, setCopiedByType] = useState({
    music: 0, podcast: 0, audiobook: 0, artwork: 0, playlist: 0,
  });
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const itemIdRef = useRef(0);
  const logIdRef = useRef(0);
  const elapsedInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncStartedRef = useRef(false);
  const progressUnsubRef = useRef<(() => void) | null>(null);
  const hasReceivedTotalRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const isRunning = !finished && !error;
  const pct = totalItems > 0 ? Math.round((processedItems / totalItems) * 100) : 0;

  const handleProgress = useCallback((p: SyncProgress) => {
    setProgress(p);

    if (p.event === "log") {
      setLogLines((prev) => {
        const next = [...prev, { id: ++logIdRef.current, text: p.message ?? p.path ?? "" }];
        return next.length > 200 ? next.slice(-200) : next;
      });
      return;
    }

    if (p.event === "total" || p.event === "total_add") {
      hasReceivedTotalRef.current = true;
      const count = Number(p.path) || 0;
      setTotalItems((prev) => prev + count);
      return;
    }

    if (p.event === "copy") {
      setProcessedItems((n) => n + 1);
      const status = String(p.status);
      const contentType = (p.contentType as string) || "unknown";
      if (status === "copied" || status === "converted") {
        setCopiedItems((n) => n + 1);
        setCopiedByType((prev) => {
          const key = contentType as keyof typeof prev;
          return key in prev ? { ...prev, [key]: prev[key] + 1 } : prev;
        });
      } else if (status === "skipped") {
        setSkippedByType((prev) => {
          const key = contentType as keyof typeof prev;
          return key in prev ? { ...prev, [key]: prev[key] + 1 } : prev;
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
    if (p.status === "error") setError(p.path || p.message || "Sync failed");
  }, []);

  useEffect(() => {
    if (finished && elapsedInterval.current) {
      clearInterval(elapsedInterval.current);
      elapsedInterval.current = null;
    }
  }, [finished]);

  useEffect(() => {
    if (!open) {
      progressUnsubRef.current?.();
      progressUnsubRef.current = null;
      syncStartedRef.current = false;
      hasReceivedTotalRef.current = false;
      return;
    }
    if (syncStartedRef.current) return;
    syncStartedRef.current = true;

    setProgress(null);
    setRecentItems([]);
    setLogLines([]);
    setTotalItems(0);
    setProcessedItems(0);
    setCopiedItems(0);
    setSkippedByType({ music: 0, podcast: 0, audiobook: 0, artwork: 0, playlist: 0 });
    setCopiedByType({ music: 0, podcast: 0, audiobook: 0, artwork: 0, playlist: 0 });
    setFinished(false);
    setError(null);
    setCancelled(false);
    setElapsedSec(0);
    hasReceivedTotalRef.current = false;

    elapsedInterval.current = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);

    const opts = syncOptions;
    const unsub = onSyncProgress(handleProgress);
    progressUnsubRef.current = unsub;

    startSync(opts)
      .then((result: { synced?: number; removed?: number; errors?: number; error?: string }) => {
        setFinished(true);
        const errMsg = result?.error != null ? String(result.error) : "";
        const isCancelled = errMsg.toLowerCase().includes("cancelled");
        if (isCancelled) {
          setCancelled(true);
        } else if (errMsg) {
          setError(errMsg);
        }
        const synced = result?.synced ?? 0;
        const errors = result?.errors ?? 0;
        const totalSkipped = processedItems - copiedItems;
        onCompleteRef.current?.({
          synced,
          skipped: totalSkipped,
          errors: isCancelled ? 0 : errors || (errMsg ? 1 : 0),
          status: isCancelled ? "warning" : errors > 0 ? (synced > 0 ? "warning" : "error") : "success",
          skippedBreakdown: skippedByType,
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
          status: "error",
          skippedBreakdown: skippedByType,
        });
      })
      .finally(() => {
        progressUnsubRef.current?.();
        progressUnsubRef.current = null;
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

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [recentItems]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const handleCancel = async () => {
    try {
      await cancelSync();
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

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="truncate max-w-[50%]">
            {progress?.event === "log" && progress?.message
              ? progress.message
              : progress?.path
                ? progress.path.split("/").pop()
                : "Preparing…"}
          </span>
          <div className="flex gap-4 tabular-nums shrink-0">
            <span>{processedItems} / {totalItems || "?"} items</span>
            <span className="text-success">{copiedItems} copied</span>
            <span className="text-muted-foreground">{Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, "0")} elapsed</span>
          </div>
        </div>

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
          {recentItems.length === 0 && (
            <p className="text-muted-foreground">
              {finished && totalItems === 0
                ? "Nothing to sync — items already up to date."
                : finished && totalItems > 0
                  ? "Sync completed."
                  : hasReceivedTotalRef.current && totalItems > 0
                    ? "Preparing files for sync…"
                    : "Waiting for sync…"}
            </p>
          )}
          {recentItems.map((item) => (
            <div key={item.id} className="flex items-start gap-2 py-0.5 text-muted-foreground">
              <span className="shrink-0">{itemStatusIcon(item.status, item.event)}</span>
              <span className="truncate">{item.path}</span>
            </div>
          ))}
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

        {finished && !error && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">{processedItems}</p>
                <p className="text-xs text-muted-foreground">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">{copiedItems}</p>
                <p className="text-xs text-muted-foreground">Copied</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">{processedItems - copiedItems}</p>
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
