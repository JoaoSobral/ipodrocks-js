import { useEffect, useRef, useState, useCallback } from "react";
import type { ScanProgress, ScanResult } from "@shared/types";
import { scanLibrary, scanCancel, onScanProgress } from "@renderer/ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ProgressBar } from "../common/ProgressBar";
import { ErrorBox } from "../common/ErrorBox";

interface ScanFolder {
  name: string;
  path: string;
  contentType: string;
}

interface RecentFile {
  id: number;
  file: string;
  status: ScanProgress["status"];
}

interface ScanProgressModalProps {
  open: boolean;
  onClose: () => void;
  folders: ScanFolder[];
}

function StatusIcon({ status }: { status: ScanProgress["status"] }) {
  switch (status) {
    case "added":
      return <span className="text-success" title="Added">▶</span>;
    case "skipped":
      return <span className="text-warning" title="Skipped">◐</span>;
    case "error":
      return <span className="text-destructive" title="Error">✕</span>;
    case "complete":
    case "cancelled":
      return <span className="text-muted-foreground">✓</span>;
    default:
      return <span className="text-muted-foreground">…</span>;
  }
}

export function ScanProgressModal({ open, onClose, folders }: ScanProgressModalProps) {
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const abortedRef = useRef(false);
  const fileIdRef = useRef(0);
  // Capture folders at the moment the modal opens; prevents a new array reference
  // from the parent (e.g. folders.map() called on every render) from re-triggering
  // the effect and restarting an in-progress scan.
  const foldersRef = useRef<ScanFolder[]>(folders);

  const isRunning = !result && !error;
  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  const addRecent = useCallback((file: string, status: ScanProgress["status"]) => {
    setRecentFiles((prev) => {
      const next = [...prev, { id: ++fileIdRef.current, file, status }];
      return next.length > 15 ? next.slice(-15) : next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Snapshot folders now so subsequent parent re-renders don't restart the scan.
    foldersRef.current = folders;
    abortedRef.current = false;
    setProgress(null);
    setResult(null);
    setError(null);
    setRecentFiles([]);

    const unsub = onScanProgress((p) => {
      setProgress(p);
      if (p.file && p.status !== "scanning") addRecent(p.file, p.status);
    });

    scanLibrary(foldersRef.current)
      .then((r) => {
        const res = r as ScanResult & { error?: string };
        if (res.error && !abortedRef.current) {
          setError(res.error);
        } else {
          setResult(r);
        }
      })
      .catch((e) => {
        if (!abortedRef.current) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      unsub();
    };
  // `folders` is intentionally omitted: we capture it in foldersRef when open
  // transitions to true, so changes to the prop reference don't restart the scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, addRecent]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [recentFiles]);

  const handleCancel = () => {
    abortedRef.current = true;
    scanCancel().catch(() => {});
  };

  const variant = result
    ? result.cancelled ? "default" : "success"
    : error ? "error" : "default";

  return (
    <Modal
      open={open}
      onClose={isRunning ? () => {} : onClose}
      title="Scanning Library"
      width="max-w-xl"
    >
      <div className="flex flex-col gap-4">
        <ProgressBar value={pct} showPercent variant={variant} />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="truncate max-w-[60%]">
            {progress?.file ? `Scanning: ${progress.file}` : "Preparing…"}
          </span>
          <span className="tabular-nums shrink-0">
            {progress ? `${progress.processed}/${progress.total}` : "—"}
          </span>
        </div>

        {/* Recent files */}
        <div
          ref={listRef}
          className="h-48 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono"
        >
          {recentFiles.length === 0 && (
            <p className="text-muted-foreground">Waiting for files…</p>
          )}
          {recentFiles.map((rf) => (
            <div key={rf.id} className="flex items-start gap-2 py-0.5 text-muted-foreground">
              <span className="shrink-0 w-4 flex justify-center">
                <StatusIcon status={rf.status} />
              </span>
              <span className="truncate">{rf.file}</span>
            </div>
          ))}
        </div>

        {/* Summary on completion */}
        {result && !("error" in result && result.error) && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">
                  {result.filesProcessed ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">
                  {result.filesAdded ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Added</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-destructive">
                  {result.filesRemoved ?? 0}
                </p>
                <p className="text-xs text-muted-foreground">Removed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">
                  {(result.filesProcessed ?? 0) - (result.filesAdded ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">Skipped</p>
              </div>
            </div>
            {result.cancelled && (
              <p className="mt-2 text-center text-xs text-warning">Scan was cancelled</p>
            )}
            {result.errors && result.errors.length > 0 && (
              <div className="mt-3">
                <ErrorBox>
                  <p className="text-xs font-semibold mb-2">Problems ({result.errors.length})</p>
                  <ul className="max-h-32 overflow-y-auto text-xs text-foreground space-y-1 font-mono">
                    {result.errors.map((line) => (
                      <li key={line} className="truncate">{line}</li>
                    ))}
                  </ul>
                </ErrorBox>
              </div>
            )}
          </div>
        )}

        {error && (
          <ErrorBox>{error}</ErrorBox>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {isRunning ? (
            <Button variant="danger" size="sm" onClick={handleCancel}>
              Stop scan
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
