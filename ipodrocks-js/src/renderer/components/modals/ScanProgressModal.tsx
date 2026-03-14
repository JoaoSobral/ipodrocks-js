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

  const isRunning = !result && !error;
  const pct = progress && progress.total > 0
    ? Math.round((progress.processed / progress.total) * 100)
    : 0;

  const addRecent = useCallback((file: string, status: ScanProgress["status"]) => {
    setRecentFiles((prev) => {
      const next = [...prev, { file, status }];
      return next.length > 15 ? next.slice(-15) : next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    abortedRef.current = false;
    setProgress(null);
    setResult(null);
    setError(null);
    setRecentFiles([]);

    const unsub = onScanProgress((p) => {
      setProgress(p);
      if (p.file) addRecent(p.file, p.status);
    });

    scanLibrary(folders)
      .then((r) => setResult(r))
      .catch((e) => {
        if (!abortedRef.current) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      unsub();
    };
  }, [open, folders, addRecent]);

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
          {recentFiles.map((rf, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5 text-muted-foreground">
              <span className="shrink-0 w-4 flex justify-center">
                <StatusIcon status={rf.status} />
              </span>
              <span className="truncate">{rf.file}</span>
            </div>
          ))}
        </div>

        {/* Summary on completion */}
        {result && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">{result.filesProcessed}</p>
                <p className="text-xs text-muted-foreground">Processed</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">{result.filesAdded}</p>
                <p className="text-xs text-muted-foreground">Added</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">
                  {result.filesProcessed - result.filesAdded}
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
                    {result.errors.map((line, i) => (
                      <li key={i} className="truncate">{line}</li>
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
