import { create } from "zustand";
import { getTracks, getLibraryStats, getLibraryFolders } from "../ipc/api";
import type { Track, LibraryFolder, LibraryStats, TrackFilter } from "../ipc/api";

export type { Track, LibraryFolder, LibraryStats };
export type FetchTracksOptions = { silent?: boolean };

interface LibraryState {
  tracks: Track[];
  folders: LibraryFolder[];
  stats: LibraryStats | null;
  loading: boolean;
  error: string | null;
  fetchTracks: (filter?: TrackFilter, options?: FetchTracksOptions) => Promise<void>;
  fetchFolders: () => Promise<void>;
  fetchStats: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  tracks: [],
  folders: [],
  stats: null,
  loading: false,
  error: null,

  fetchTracks: async (filter, options) => {
    const silent = options?.silent ?? false;
    if (!silent) set({ loading: true, error: null });
    try {
      const tracks = await getTracks(filter);
      set(silent ? { tracks, error: null } : { tracks, error: null, loading: false });
    } catch (e) {
      set(silent ? { error: (e as Error).message } : { error: (e as Error).message, loading: false });
    }
  },

  fetchFolders: async () => {
    try {
      const folders = await getLibraryFolders();
      set({ folders, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  fetchStats: async () => {
    try {
      const stats = await getLibraryStats();
      set({ stats, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
}));
