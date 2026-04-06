import { create } from "zustand";
import { getTracks, getLibraryStats, getLibraryFolders } from "../ipc/api";
import type { Track, LibraryFolder, LibraryStats, TrackFilter } from "../ipc/api";

export type { Track, LibraryFolder, LibraryStats };

interface LibraryState {
  tracks: Track[];
  folders: LibraryFolder[];
  stats: LibraryStats | null;
  loading: boolean;
  error: string | null;
  fetchTracks: (filter?: TrackFilter) => Promise<void>;
  fetchFolders: () => Promise<void>;
  fetchStats: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  tracks: [],
  folders: [],
  stats: null,
  loading: false,
  error: null,

  fetchTracks: async (filter) => {
    set({ loading: true, error: null });
    try {
      const tracks = await getTracks(filter);
      set({ tracks, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
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
