import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelRepairMpcTags,
  onMpcRepairProgress,
  repairMpcTags,
  type MpcRepairProgress,
  type MpcRepairSummary,
} from "../../ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ErrorBox } from "../common/ErrorBox";

interface MpcTagRepairModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Issue #125 — repairs the malformed APEv2 cover-art item in Musepack files
 * iPodRocks already wrote into shadow libraries and onto devices.
 *
 * Self-starting, like BackfillProgressModal: opening it kicks off the job and
 * subscribes, so the Settings panel needs no job state of its own. The total is
 * unknown up front (the pass discovers files as it walks), so this reports a
 * running count rather than a percentage bar.
 */
export function MpcTagRepairModal({ open, onClose }: MpcTagRepairModalProps) {
  const [progress, setProgress] = useState<MpcRepairProgress | null>(null);
  const [summary, setSummary] = useState<MpcRepairSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const startedRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    setProgress(null);
    setSummary(null);
    setError(null);
    setFinished(false);
  }, []);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      unsubRef.current?.();
      unsubRef.current = null;
      reset();
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    unsubRef.current = onMpcRepairProgress(setProgress);

    repairMpcTags()
      .then((result) => {
        if (result?.error) setError(result.error);
        else setSummary(result);
        setFinished(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setFinished(true);
      })
      .finally(() => {
        unsubRef.current?.();
        unsubRef.current = null;
      });

    return () => {
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, [open, reset]);

  const isRunning = !finished;
  const scanned = summary?.scanned ?? progress?.scanned ?? 0;
  const repaired = summary?.repaired ?? progress?.repaired ?? 0;
  const failed = summary?.failed ?? progress?.failed ?? 0;

  return (
    <Modal
      open={open}
      onClose={isRunning ? () => {} : onClose}
      title="Repairing Musepack Tags"
      wide
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          Checking every Musepack file in your shadow libraries and on connected
          devices, and rewriting the cover-art tag where it was written
          incorrectly. Only the tag is touched — the audio is never re-encoded.
        </p>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="truncate max-w-[50%]">
            {isRunning
              ? (progress?.label ?? "Preparing…")
              : summary?.cancelled
                ? "Cancelled"
                : "Finished"}
          </span>
          <div className="flex gap-4 tabular-nums shrink-0">
            <span data-testid="mpc-repair-scanned">{scanned} checked</span>
            <span className="text-success" data-testid="mpc-repair-repaired">
              {repaired} repaired
            </span>
            {failed > 0 && (
              <span className="text-destructive">{failed} failed</span>
            )}
          </div>
        </div>

        <div className="h-40 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono">
          {isRunning && (
            <p className="text-muted-foreground truncate">
              {progress?.currentFile
                ? progress.currentFile.split("/").pop()
                : "Looking for Musepack files…"}
            </p>
          )}
          {!isRunning && summary && summary.scopes.length === 0 && (
            <p className="text-muted-foreground">
              No Musepack files were found in your shadow libraries or on any
              connected device.
            </p>
          )}
          {!isRunning &&
            summary?.scopes.map((scope) => (
              <div
                key={scope.label}
                className="flex items-start justify-between gap-2 py-0.5 text-muted-foreground"
              >
                <span className="truncate">{scope.label}</span>
                <span className="shrink-0 tabular-nums">
                  {scope.repaired} / {scope.scanned}
                </span>
              </div>
            ))}
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}

        {finished && !error && summary && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            {summary.cancelled && (
              <p className="mb-3 text-center text-sm text-warning">
                Repair cancelled — the files already checked were repaired.
              </p>
            )}
            <p className="text-center text-sm text-foreground">
              Checked {summary.scanned} Musepack file
              {summary.scanned === 1 ? "" : "s"}, repaired {summary.repaired}
              {summary.failed > 0 && `, ${summary.failed} could not be written`}
              .
            </p>
            {summary.repaired > 0 && (
              <p className="mt-3 text-xs text-muted-foreground border-t border-border pt-3">
                Repaired files keep their size and timestamp, so nothing will be
                re-transcoded or re-copied on your next sync.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          {isRunning ? (
            <Button variant="danger" size="sm" onClick={cancelRepairMpcTags}>
              Cancel
            </Button>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
