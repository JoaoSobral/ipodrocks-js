import { create } from "zustand";
import type { LosslessProgress, LosslessScanOptions, LosslessScanResult, LosslessVerdict } from "@shared/types";
import {
  cancelLosslessCheck,
  getLosslessStatus,
  onLosslessProgress,
  startLosslessCheck,
} from "../ipc/api";

export interface LosslessLogItem {
  id: number;
  path: string;
  phase: "light" | "deep";
  verdict: LosslessVerdict;
}

interface LosslessState {
  running: boolean;
  progress: LosslessProgress | null;
  result: LosslessScanResult | null;
  error: string | null;
  log: LosslessLogItem[];
  /** Bumped when a run finishes or files are deleted, so views re-read the report. */
  reportVersion: number;
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
  bumpReport: () => void;
  /** Subscribe to progress once for the app's lifetime and pick up a run already going. */
  init: () => void;
  start: (opts: LosslessScanOptions) => Promise<void>;
  cancel: () => Promise<void>;
}

const LOG_LIMIT = 40;
let subscribed = false;
let logId = 0;

/**
 * The lossless check's client-side state lives here, not in the modal: the
 * check runs in the main process for as long as it takes, and the modal can be
 * minimised ("−"), the panel left and the window minimised meanwhile. This
 * store keeps listening throughout, so the toolbar chip and a re-opened modal
 * both show the live run.
 */
export const useLosslessStore = create<LosslessState>((set, get) => ({
  running: false,
  progress: null,
  result: null,
  error: null,
  log: [],
  reportVersion: 0,
  modalOpen: false,
  setModalOpen: (open) => set({ modalOpen: open }),
  bumpReport: () => set((s) => ({ reportVersion: s.reportVersion + 1 })),

  init: () => {
    if (subscribed) return;
    subscribed = true;
    onLosslessProgress((p) => {
      const terminal = p.phase === "complete" || p.phase === "cancelled" || p.phase === "error";
      set((s) => ({
        progress: p,
        running: !terminal,
        error: p.phase === "error" ? p.message ?? "The lossless check failed." : s.error,
        log:
          p.verdict && p.path && (p.phase === "light" || p.phase === "deep")
            ? [...s.log, { id: ++logId, path: p.path, phase: p.phase, verdict: p.verdict }].slice(-LOG_LIMIT)
            : s.log,
        reportVersion: terminal ? s.reportVersion + 1 : s.reportVersion,
      }));
    });
    getLosslessStatus()
      .then((st) => {
        if (st.running) set({ running: true, progress: st.progress });
        else if (st.lastResult && !get().result) set({ result: st.lastResult });
      })
      .catch(() => {});
  },

  start: async (opts) => {
    get().init();
    set({ running: true, progress: null, result: null, error: null, log: [] });
    try {
      const result = await startLosslessCheck(opts);
      set((s) => ({
        result,
        running: false,
        error: result.error ?? null,
        reportVersion: s.reportVersion + 1,
      }));
    } catch (err) {
      set({ running: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  cancel: async () => {
    await cancelLosslessCheck().catch((err) =>
      set({ error: err instanceof Error ? err.message : String(err) })
    );
  },
}));
