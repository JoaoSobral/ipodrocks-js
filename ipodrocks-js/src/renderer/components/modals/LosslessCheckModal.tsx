import { useEffect, useMemo, useState } from "react";
import {
  LOSSLESS_FLAGGED_VERDICTS,
  LOSSLESS_VERDICT_LABELS,
  type LosslessDeleteResult,
  type LosslessReportRow,
  type LosslessScanOptions,
  type LosslessVerdict,
} from "@shared/types";
import {
  deleteLosslessFlagged,
  getLosslessReport,
  losslessHostHasTrash,
  setLosslessOverride,
} from "../../ipc/api";
import { useLosslessStore } from "../../stores/lossless-store";
import { downloadTextFile } from "../../utils/download";
import {
  formatConfidence,
  formatCutoff,
  losslessReportCsv,
  losslessReportMarkdown,
} from "../../utils/lossless-report";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { ProgressBar } from "../common/ProgressBar";
import { ErrorBox } from "../common/ErrorBox";
import { Switch } from "../common/Switch";
import { LosslessBadge, losslessTooltip } from "../common/LosslessBadge";

type Filter = "flagged" | LosslessVerdict | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "flagged", label: "Flagged" },
  { value: "lossy_strong", label: LOSSLESS_VERDICT_LABELS.lossy_strong },
  { value: "lossy", label: LOSSLESS_VERDICT_LABELS.lossy },
  { value: "upsampled", label: "Upsampled" },
  { value: "possibly_lossy", label: "Possibly lossy" },
  { value: "all", label: "All checked" },
];

const FLAGGED = new Set<LosslessVerdict>(LOSSLESS_FLAGGED_VERDICTS);

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Props {
  /** Library changed (files deleted): the panel re-reads its tracks. */
  onLibraryChanged?: () => void;
  /** Rocksy's request: open and start straight away with these options. */
  autoStart?: LosslessScanOptions | null;
  onAutoStartConsumed?: () => void;
}

/**
 * The Lossless Check window. Its open/closed state and the run itself live in
 * `useLosslessStore`, so "−" only hides it: the check keeps going in the main
 * process and the toolbar chip re-opens it.
 */
export function LosslessCheckModal({ onLibraryChanged, autoStart, onAutoStartConsumed }: Props) {
  const open = useLosslessStore((s) => s.modalOpen);
  const setOpen = useLosslessStore((s) => s.setModalOpen);
  const running = useLosslessStore((s) => s.running);
  const progress = useLosslessStore((s) => s.progress);
  const result = useLosslessStore((s) => s.result);
  const runError = useLosslessStore((s) => s.error);
  const log = useLosslessStore((s) => s.log);
  const reportVersion = useLosslessStore((s) => s.reportVersion);
  const start = useLosslessStore((s) => s.start);
  const cancel = useLosslessStore((s) => s.cancel);
  const bumpReport = useLosslessStore((s) => s.bumpReport);

  // Which step shows is derived, not tracked: a run shows progress, and
  // otherwise the results whenever there are any — unless the user asked for
  // a new check. Tracking it in effects raced the run's own completion.
  const [forceSetup, setForceSetup] = useState(false);
  const [scope, setScope] = useState<"unchecked" | "all">("unchecked");
  const [deep, setDeep] = useState(true);
  const [report, setReport] = useState<LosslessReportRow[]>([]);
  const [filter, setFilter] = useState<Filter>("flagged");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasTrash, setHasTrash] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<LosslessDeleteResult | null>(null);

  // Rocksy started one: open, and go.
  useEffect(() => {
    if (!autoStart) return;
    onAutoStartConsumed?.();
    setOpen(true);
    setForceSetup(false);
    if (!running) void start(autoStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  useEffect(() => {
    if (!open) return;
    losslessHostHasTrash().then(setHasTrash).catch(() => setHasTrash(false));
  }, [open]);

  // (Re)load the report whenever the window opens or a run/delete finishes.
  useEffect(() => {
    if (!open) return;
    getLosslessReport()
      .then(setReport)
      .catch((err) => setActionError(err instanceof Error ? err.message : String(err)));
  }, [open, reportVersion]);

  const view: "setup" | "results" = forceSetup || (report.length === 0 && !result) ? "setup" : "results";

  const visible = useMemo(() => {
    if (filter === "all") return report;
    if (filter === "flagged") return report.filter((r) => FLAGGED.has(r.verdict) && !r.override);
    return report.filter((r) => r.verdict === filter);
  }, [report, filter]);

  const counts = useMemo(() => {
    const c: Partial<Record<LosslessVerdict, number>> = {};
    for (const r of report) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    return c;
  }, [report]);

  const deletable = [...selected].filter((id) => {
    const r = report.find((x) => x.trackId === id);
    return r && FLAGGED.has(r.verdict) && !r.override;
  });

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    const ids = visible.map((r) => r.trackId);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function markOk(ok: boolean) {
    setBusy(true);
    setActionError(null);
    try {
      await setLosslessOverride([...selected], ok);
      setSelected(new Set());
      bumpReport();
      onLibraryChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    setActionError(null);
    try {
      const r = await deleteLosslessFlagged(deletable);
      setDeleteResult(r);
      setSelected(new Set());
      setConfirmDelete(false);
      bumpReport();
      onLibraryChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const minimize = () => setOpen(false);

  const pct =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const phaseLabel =
    progress?.phase === "deep"
      ? `Deep check of suspects — ${progress.processed} / ${progress.total}`
      : progress?.phase === "light"
        ? `Quick check — ${progress.processed} / ${progress.total} · ${progress.suspects} suspect(s)`
        : "Preparing…";

  return (
    <Modal
      open={open}
      onClose={minimize}
      closeIcon={running ? "−" : "✕"}
      title="Lossless Check"
      width="max-w-5xl"
    >
      <div className="flex flex-col gap-4" data-testid="lossless-check-modal">
        {running ? (
          <>
            <p className="text-xs text-muted-foreground">
              Runs in the background — press <strong>−</strong> to keep using iPodRocks; the
              progress chip in the Library toolbar brings this back.
            </p>
            <ProgressBar value={pct} showPercent />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[60%]">
                {progress?.path ? fileName(progress.path) : "Preparing…"}
              </span>
              <span className="tabular-nums shrink-0" data-testid="lossless-phase">
                {phaseLabel}
              </span>
            </div>
            <div className="h-48 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono">
              {log.length === 0 && <p className="text-muted-foreground">Waiting for the first file…</p>}
              {log.map((item) => (
                <div key={item.id} className="flex items-center gap-2 py-0.5 text-muted-foreground">
                  <LosslessBadge verdict={item.verdict} />
                  <span className="text-[10px] uppercase shrink-0">{item.phase}</span>
                  <span className="truncate">{fileName(item.path)}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={minimize} data-testid="lossless-background">
                Run in background
              </Button>
              <Button variant="danger" size="sm" onClick={() => void cancel()}>
                Cancel
              </Button>
            </div>
          </>
        ) : view === "setup" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Looks inside your FLAC, ALAC, WAV and AIFF files for the frequency cutoff a lossy
              encoder (MP3, AAC) leaves behind — the mark of a file converted from a lossy source —
              and for hi-res files that only hold CD-quality audio. A quick pass checks every file;
              suspects then get a deep check across the whole track.
            </p>
            <p className="text-xs text-muted-foreground">
              A verdict describes the audio, not the seller: a legitimately bought edit can be made
              from a compressed source too. Files you know are fine can be marked OK.
            </p>
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground w-28 shrink-0">Files</span>
                <Button
                  size="sm"
                  variant={scope === "unchecked" ? "primary" : "secondary"}
                  onClick={() => setScope("unchecked")}
                >
                  Only unchecked
                </Button>
                <Button
                  size="sm"
                  variant={scope === "all" ? "primary" : "secondary"}
                  onClick={() => setScope("all")}
                >
                  Re-check all
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground w-28 shrink-0">Deep check</span>
                <Switch checked={deep} onChange={setDeep} aria-label="Deep check suspects" />
                <span className="text-xs text-muted-foreground">
                  Analyse suspects across the whole track (recommended)
                </span>
              </label>
            </div>
            {runError && <ErrorBox>{runError}</ErrorBox>}
            <div className="flex justify-end gap-2">
              {report.length > 0 && (
                <Button size="sm" onClick={() => setForceSetup(false)}>
                  View last results
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                data-testid="lossless-start"
                onClick={() => {
                  setForceSetup(false);
                  void start({ scope, deep });
                }}
              >
                Start check
              </Button>
            </div>
          </>
        ) : (
          <>
            {result && (
              <p className="text-xs text-muted-foreground" data-testid="lossless-summary">
                {result.cancelled ? "Cancelled — " : ""}
                {result.checked} file(s) checked, {result.deepChecked} deep-checked.
              </p>
            )}
            {runError && <ErrorBox>{runError}</ErrorBox>}
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((f) => {
                const n =
                  f.value === "all"
                    ? report.length
                    : f.value === "flagged"
                      ? report.filter((r) => FLAGGED.has(r.verdict) && !r.override).length
                      : counts[f.value] ?? 0;
                return (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={filter === f.value ? "primary" : "ghost"}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label} ({n})
                  </Button>
                );
              })}
            </div>

            <div className="max-h-[45vh] overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs" data-testid="lossless-results">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr className="text-left">
                    <th className="p-2 w-6">
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={visible.length > 0 && visible.every((r) => selected.has(r.trackId))}
                        onChange={toggleAllVisible}
                      />
                    </th>
                    <th className="p-2">Title</th>
                    <th className="p-2">Artist</th>
                    <th className="p-2">Album</th>
                    <th className="p-2">Verdict</th>
                    <th className="p-2 text-right">Confidence</th>
                    <th className="p-2 text-right">Cutoff</th>
                    <th className="p-2">Likely source</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-4 text-center text-muted-foreground">
                        {report.length === 0 ? "Nothing checked yet." : "No tracks match this filter."}
                      </td>
                    </tr>
                  )}
                  {visible.map((r) => {
                    const flagged = FLAGGED.has(r.verdict) && !r.override;
                    return (
                      <tr
                        key={r.trackId}
                        className="border-t border-border hover:bg-muted/30"
                        data-testid="lossless-row"
                        data-path={r.path}
                        data-verdict={r.verdict}
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.title}`}
                            checked={selected.has(r.trackId)}
                            onChange={() => toggle(r.trackId)}
                          />
                        </td>
                        <td className="p-2 max-w-[14rem]">
                          <div className="truncate text-foreground" title={r.title}>{r.title}</div>
                          <div className="truncate text-[10px] text-muted-foreground" title={r.path}>
                            {r.path}
                          </div>
                        </td>
                        <td className="p-2 max-w-[9rem] truncate" title={r.artist}>{r.artist}</td>
                        <td className="p-2 max-w-[9rem] truncate" title={r.album}>{r.album}</td>
                        <td className="p-2">
                          <LosslessBadge
                            verdict={r.verdict}
                            override={r.override}
                            full
                            title={losslessTooltip(r.verdict, r)}
                          />
                        </td>
                        <td className="p-2 text-right tabular-nums">{formatConfidence(r.confidence)}</td>
                        <td
                          className="p-2 text-right tabular-nums"
                          title={
                            r.cliffDb != null
                              ? `Drops ${r.cliffDb} dB at the cutoff; ${r.depthDb} dB below the music above it; empty in ${Math.round((r.emptyShare ?? 0) * 100)}% of frames`
                              : undefined
                          }
                        >
                          {/* On a genuine file the "cutoff" is only where the music fades out. */}
                          {flagged ? formatCutoff(r.cutoffHz) : ""}
                        </td>
                        <td className="p-2 text-muted-foreground">{flagged ? r.source ?? "" : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {actionError && <ErrorBox>{actionError}</ErrorBox>}
            {deleteResult && (
              <p className="text-xs text-muted-foreground" data-testid="lossless-delete-result">
                Deleted {deleteResult.deleted} file(s)
                {deleteResult.trashed ? ` — ${deleteResult.trashed} moved to the Trash` : ""}
                {deleteResult.permanent ? ` — ${deleteResult.permanent} deleted permanently` : ""}
                {deleteResult.failed.length ? ` — ${deleteResult.failed.length} could not be deleted` : ""}.
              </p>
            )}

            {confirmDelete ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm flex flex-col gap-2">
                <p>
                  Delete <strong>{deletable.length}</strong> file(s) from disk and from the library?{" "}
                  {hasTrash ? (
                    <>They will be moved to the Trash.</>
                  ) : (
                    <strong>This server has no Trash: they will be deleted permanently.</strong>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Only flagged files are deleted; anything else in the selection is left alone.
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                    Keep them
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void doDelete()}
                    disabled={busy}
                    data-testid="lossless-confirm-delete"
                  >
                    Delete {deletable.length} file(s)
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => downloadTextFile(`lossless-check-${stamp()}.csv`, "text/csv", losslessReportCsv(visible))}
                  disabled={visible.length === 0}
                >
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    downloadTextFile(`lossless-check-${stamp()}.md`, "text/markdown", losslessReportMarkdown(visible))
                  }
                  disabled={visible.length === 0}
                >
                  Export Markdown
                </Button>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => void markOk(true)} disabled={busy || selected.size === 0}>
                  Mark as OK
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void markOk(false)} disabled={busy || selected.size === 0}>
                  Unmark
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || deletable.length === 0}
                  onClick={() => {
                    setDeleteResult(null);
                    setConfirmDelete(true);
                  }}
                  data-testid="lossless-delete"
                >
                  Delete selected…
                </Button>
                <Button size="sm" variant="primary" onClick={() => setForceSetup(true)}>
                  New check
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
