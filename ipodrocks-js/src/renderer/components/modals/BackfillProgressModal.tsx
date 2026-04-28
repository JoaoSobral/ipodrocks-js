import { useEffect, useRef, useState, useCallback } from "react";
import type { BackfillProgress } from "@shared/types";
import {
  onBackfillProgress,
  backfillSavantFeatures,
  cancelBackfill,
} from "../../ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ProgressBar } from "../common/ProgressBar";
import { ErrorBox } from "../common/ErrorBox";

interface RecentItem {
  id: number;
  path: string;
  success: boolean;
}

export interface BackfillCompleteResult {
  processed: number;
  total: number;
  status: "success" | "error" | "cancelled";
}

interface BackfillProgressModalProps {
  open: boolean;
  onClose: () => void;
  backfillOpts?: { percent?: number };
  onComplete?: (result: BackfillCompleteResult) => void;
}

export function BackfillProgressModal({
  open,
  onClose,
  backfillOpts,
  onComplete,
}: BackfillProgressModalProps) {
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const itemIdRef = useRef(0);
  const elapsedInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const backfillStartedRef = useRef(false);
  const progressUnsubRef = useRef<(() => void) | null>(null);
  const onCompleteRef = useRef(onComplete);
  const totalRef = useRef(0);
  const lastProcessedRef = useRef(0);
  onCompleteRef.current = onComplete;

  const total = progress?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  const handleProgress = useCallback((p: BackfillProgress) => {
    setProgress(p);
    if (p.total > 0) totalRef.current = p.total;

    if (p.status === "complete") {
      setFinished(true);
      return;
    }
    if (p.status === "error") {
      setError(p.message ?? "Backfill failed");
      setFinished(true);
      return;
    }
    if (p.status === "cancelled") {
      setCancelled(true);
      setFinished(true);
      return;
    }

    if (p.path && p.processed > lastProcessedRef.current) {
      lastProcessedRef.current = p.processed;
      setProcessedCount((n) => n + (p.success ? 1 : 0));
      setRecentItems((prev) => {
        const next = [...prev, { id: ++itemIdRef.current, path: p.path, success: p.success }];
        return next.length > 30 ? next.slice(-30) : next;
      });
    }
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
      backfillStartedRef.current = false;
      return;
    }
    if (backfillStartedRef.current) return;
    backfillStartedRef.current = true;

    setProgress(null);
    setRecentItems([]);
    setFinished(false);
    setError(null);
    setElapsedSec(0);
    setProcessedCount(0);
    lastProcessedRef.current = 0;
    totalRef.current = 0;

    elapsedInterval.current = setInterval(() => {
      setElapsedSec((s) => s + 1);
    }, 1000);

    const unsub = onBackfillProgress(handleProgress);
    progressUnsubRef.current = unsub;

    backfillSavantFeatures(backfillOpts)
      .then((result) => {
        setFinished(true);
        if (result.cancelled) setCancelled(true);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setFinished(true);
      })
      .finally(() => {
        progressUnsubRef.current?.();
        progressUnsubRef.current = null;
        backfillStartedRef.current = false;
      });

    return () => {
      if (elapsedInterval.current) {
        clearInterval(elapsedInterval.current);
        elapsedInterval.current = null;
      }
    };
  }, [open, handleProgress, backfillOpts]);

  const isRunning = !finished && !error;
  const variant = finished ? (error ? "error" : "success") : "default";

  return (
    <Modal
      open={open}
      onClose={isRunning ? () => {} : onClose}
      title="Backfilling Key Data"
      wide
    >
      <div className="flex flex-col gap-4">
        <ProgressBar value={pct} showPercent variant={variant} />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="truncate max-w-[50%]">
            {progress?.path
              ? String(progress.path).split("/").pop()
              : "Preparing…"}
          </span>
          <div className="flex gap-4 tabular-nums shrink-0">
            <span>{processed} / {total || "?"} tracks</span>
            <span className="text-success">{processedCount} with key</span>
            <span className="text-muted-foreground">
              {Math.floor(elapsedSec / 60)}:
              {String(elapsedSec % 60).padStart(2, "0")} elapsed
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Progress</span>
          <div
            ref={listRef}
            className="h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono"
          >
            {recentItems.length === 0 && (
              <p className="text-muted-foreground">
                {finished
                  ? "No tracks were found to process."
                  : total
                    ? "Analyzing tracks…"
                    : "Waiting for backfill…"}
              </p>
            )}
            {recentItems.map((item) => (
              <div
                key={item.id}
                className="flex items-start gap-2 py-0.5 text-muted-foreground"
              >
                <span className="shrink-0">
                  {item.success ? "✓" : "—"}
                </span>
                <span className="truncate">
                  {item.path ? item.path.split("/").pop() : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <ErrorBox>{error}</ErrorBox>
        )}

        {finished && !error && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            {cancelled && (
              <p className="mb-3 text-center text-sm text-warning">
                Backfill cancelled
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">{processed}</p>
                <p className="text-xs text-muted-foreground">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">
                  {processedCount}
                </p>
                <p className="text-xs text-muted-foreground">With key/BPM</p>
              </div>
            </div>
            {!cancelled && processedCount === 0 && (
              <p className="mt-3 text-xs text-muted-foreground border-t border-border pt-3">
                No key data was found in your file tags. Enable{" "}
                <strong>Essentia.js analysis</strong> in{" "}
                <em>Settings → Savant</em> and run Backfill again to detect
                keys directly from your audio waveforms.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {isRunning ? (
            <Button variant="danger" size="sm" onClick={cancelBackfill}>
              Cancel
            </Button>
          ) : (
            <Button
              onClick={() => {
                onCompleteRef.current?.({
                  processed,
                  total,
                  status: error ? "error" : cancelled ? "cancelled" : "success",
                });
                onClose();
              }}
            >
              Done
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
