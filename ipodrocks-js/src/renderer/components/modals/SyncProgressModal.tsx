import { useEffect, useRef, useState, useCallback } from "react";
import type { SyncOptions, SyncProgress } from "@shared/types";
import { startSync, cancelSync, onSyncProgress } from "@renderer/ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ProgressBar } from "../common/ProgressBar";

interface RecentItem {
  path: string;
  event: string;
  status: SyncProgress["status"];
}

export interface SyncCompleteResult {
  synced: number;
  skipped: number;
  errors: number;
  status: "success" | "error" | "warning";
}

interface SyncProgressModalProps {
  open: boolean;
  onClose: () => void;
  syncOptions: SyncOptions;
  onComplete?: (result: SyncCompleteResult) => void;
}

const statusIcon: Record<string, string> = {
  copy: "✅",
  skip: "⏭️",
  error: "❌",
  remove: "🗑️",
};

function eventIcon(event: string): string {
  return statusIcon[event] ?? "⏭️";
}

export function SyncProgressModal({
  open,
  onClose,
  syncOptions,
  onComplete,
}: SyncProgressModalProps) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [processedItems, setProcessedItems] = useState(0);
  const [copiedItems, setCopiedItems] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
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
      setLogLines((prev) => [...prev, p.message ?? p.path ?? ""]);
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
      if (status === "copied" || status === "converted") {
        setCopiedItems((n) => n + 1);
      }
      setRecentItems((prev) => {
        const next = [...prev, { path: p.path, event: p.event, status: p.status }];
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
        onCompleteRef.current?.({
          synced,
          skipped: 0,
          errors: isCancelled ? 0 : errors || (errMsg ? 1 : 0),
          status: isCancelled ? "warning" : errors > 0 ? (synced > 0 ? "warning" : "error") : "success",
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
      ...recentItems.map((r) => `[${r.event}] ${r.path}`),
      "",
      "=== Conversion log ===",
      ...logLines,
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

        <div className="flex items-center justify-between text-xs text-[#8a8f98]">
          <span className="truncate max-w-[50%]">
            {progress?.event === "log" && progress?.message
              ? progress.message
              : progress?.path
                ? progress.path.split("/").pop()
                : "Preparing…"}
          </span>
          <div className="flex gap-4 tabular-nums shrink-0">
            <span>{processedItems} / {totalItems || "?"} items</span>
            <span className="text-[#22c55e]">{copiedItems} copied</span>
            <span className="text-[#5a5f68]">{Math.floor(elapsedSec / 60)}:{String(elapsedSec % 60).padStart(2, "0")} elapsed</span>
          </div>
        </div>

        {/* Recent items */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#8a8f98]">Progress</span>
          <button
            type="button"
            onClick={handleCopyLog}
            className="text-xs text-[#4a9eff] hover:text-[#6ab0ff] transition-colors flex items-center gap-1"
            title="Copy full log to clipboard"
          >
            📋 Copy log
          </button>
        </div>
        <div
          ref={listRef}
          className="h-40 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-3 text-xs font-mono"
        >
          {recentItems.length === 0 && (
            <p className="text-[#5a5f68]">
              {finished && totalItems === 0
                ? "Nothing to sync — items already up to date."
                : finished && totalItems > 0
                  ? "Sync completed."
                  : hasReceivedTotalRef.current && totalItems > 0
                    ? "Preparing files for sync…"
                    : "Waiting for sync…"}
            </p>
          )}
          {recentItems.map((item, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5 text-[#8a8f98]">
              <span className="shrink-0">{eventIcon(item.event)}</span>
              <span className="truncate">{item.path}</span>
            </div>
          ))}
        </div>

        {/* Conversion log */}
        {logLines.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[#8a8f98]">Conversion Log</span>
            <div
              ref={logRef}
              className="h-28 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-3 text-xs font-mono text-[#8a8f98]"
            >
              {logLines.map((line, i) => (
                <div key={i} className="py-0.5">{line}</div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-3 py-2 text-sm text-[#ef4444]">
            {error}
          </div>
        )}

        {finished && !error && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-white">{processedItems}</p>
                <p className="text-xs text-[#8a8f98]">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[#22c55e]">{copiedItems}</p>
                <p className="text-xs text-[#8a8f98]">Copied</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[#8a8f98]">{processedItems - copiedItems}</p>
                <p className="text-xs text-[#8a8f98]">Skipped</p>
              </div>
            </div>
            {cancelled && (
              <p className="mt-2 text-center text-xs text-[#f5bf42]">Sync was cancelled</p>
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
