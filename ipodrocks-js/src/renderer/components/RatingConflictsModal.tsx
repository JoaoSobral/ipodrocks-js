import { useEffect, useState } from "react";
import { Modal } from "./common/Modal";
import { Button } from "./common/Button";
import { ErrorBox } from "./common/ErrorBox";
import { Spinner } from "./common/Spinner";
import { RatingStars } from "./RatingStars";
import { getRatingConflicts, resolveRatingConflict } from "../ipc/api";
import type { RatingConflictRow } from "@shared/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface RowState {
  manualOpen: boolean;
  manualRating: number | null;
  resolving: boolean;
  error: string | null;
}

export function RatingConflictsModal({ open, onClose }: Props) {
  const [conflicts, setConflicts] = useState<RatingConflictRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<number, RowState>>({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    getRatingConflicts()
      .then((rows) => {
        setConflicts(rows);
        const initial: Record<number, RowState> = {};
        for (const r of rows) {
          initial[r.id] = { manualOpen: false, manualRating: r.canonical_rating, resolving: false, error: null };
        }
        setRowState(initial);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  function patchRow(id: number, patch: Partial<RowState>) {
    setRowState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function resolve(
    conflict: RatingConflictRow,
    resolution: "device_wins" | "canonical_wins" | "manual",
    manualRating?: number
  ) {
    patchRow(conflict.id, { resolving: true, error: null });
    try {
      await resolveRatingConflict(conflict.id, resolution, manualRating);
      setConflicts((prev) => prev.filter((c) => c.id !== conflict.id));
    } catch (e) {
      patchRow(conflict.id, { error: e instanceof Error ? e.message : String(e), resolving: false });
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Rating Conflicts" width="max-w-2xl" closeOnBackdropClick>
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      )}

      {!loading && error && <ErrorBox>{error}</ErrorBox>}

      {!loading && !error && conflicts.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-8">No rating conflicts — all resolved.</p>
      )}

      {!loading && !error && conflicts.length > 0 && (
        <div className="flex flex-col divide-y divide-border">
          {conflicts.map((conflict) => {
            const rs = rowState[conflict.id] ?? { manualOpen: false, manualRating: conflict.canonical_rating, resolving: false, error: null };
            return (
              <div key={conflict.id} className="py-4 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-foreground truncate">{conflict.title}</span>
                    <span className="text-xs text-muted-foreground truncate">{conflict.artist}</span>
                  </div>
                  <span className="shrink-0 text-[10px] bg-secondary text-secondary-foreground border border-border rounded px-1.5 py-0.5">
                    {conflict.device_name}
                  </span>
                </div>

                <div className="flex items-center gap-6 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span>Device</span>
                    <RatingStars rating={conflict.reported_rating} readonly size="sm" />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span>Library</span>
                    <RatingStars rating={conflict.canonical_rating} readonly size="sm" />
                  </div>
                </div>

                {rs.error && <ErrorBox className="text-xs">{rs.error}</ErrorBox>}

                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    size="sm"
                    disabled={rs.resolving}
                    onClick={() => resolve(conflict, "canonical_wins")}
                  >
                    Keep Library
                  </Button>
                  <Button
                    size="sm"
                    disabled={rs.resolving}
                    onClick={() => resolve(conflict, "device_wins")}
                  >
                    Use Device
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={rs.resolving}
                    onClick={() => patchRow(conflict.id, { manualOpen: !rs.manualOpen })}
                  >
                    Set Manually {rs.manualOpen ? "▴" : "▾"}
                  </Button>
                </div>

                {rs.manualOpen && (
                  <div className="flex items-center gap-3 pl-1">
                    <RatingStars
                      rating={rs.manualRating}
                      size="md"
                      onChange={(r) => patchRow(conflict.id, { manualRating: r })}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={rs.resolving}
                      onClick={() => resolve(conflict, "manual", rs.manualRating ?? undefined)}
                    >
                      {rs.resolving ? "Saving…" : "Save"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
