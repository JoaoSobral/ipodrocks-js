import { create } from "zustand";

export interface SyncFileEntry {
  path: string;
  destination: string;
  status: "pending" | "syncing" | "complete" | "error" | "cancelled";
  contentType: string;
}

export interface SyncResults {
  synced: number;
  skipped: number;
  removed: number;
  errors: number;
  status: "success" | "error" | "warning";
}

interface SyncState {
  syncing: boolean;
  progress: number;
  currentFile: string;
  recentFiles: SyncFileEntry[];
  processed: number;
  total: number;
  copied: number;
  results: SyncResults | null;
  setSyncing: (syncing: boolean) => void;
  addFileEntry: (entry: SyncFileEntry) => void;
  setProgress: (
    progress: Partial<Pick<SyncState, "progress" | "currentFile" | "processed" | "total" | "copied">>,
  ) => void;
  setResults: (results: SyncResults | null) => void;
  reset: () => void;
}

const initial = {
  syncing: false,
  progress: 0,
  currentFile: "",
  recentFiles: [] as SyncFileEntry[],
  processed: 0,
  total: 0,
  copied: 0,
  results: null as SyncResults | null,
};

export const useSyncStore = create<SyncState>((set) => ({
  ...initial,

  setSyncing: (syncing) => set({ syncing }),

  addFileEntry: (entry) =>
    set((state) => {
      const processed = state.processed + 1;
      return {
        recentFiles: [entry, ...state.recentFiles].slice(0, 20),
        processed,
        copied: entry.status === "complete" ? state.copied + 1 : state.copied,
        currentFile: entry.path,
        progress: state.total > 0 ? (processed / state.total) * 100 : 0,
      };
    }),

  setProgress: (p) => set((state) => ({ ...state, ...p })),
  setResults: (results) => set({ results }),
  reset: () => set(initial),
}));
