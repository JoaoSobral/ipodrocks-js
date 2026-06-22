import { create } from "zustand";
import type { AudiobookSubscription, AudiobookChapter, LibrivoxSearchResult } from "../ipc/api";
import {
  audiobookListSubs,
  audiobookSubscribe,
  audiobookUnsubscribe,
  audiobookSearch,
  audiobookListChapters,
  audiobookRefreshCover,
  audiobookSetCoverFromUrl,
} from "../ipc/api";

interface AudiobooksState {
  subscriptions: AudiobookSubscription[];
  chaptersBySub: Record<number, AudiobookChapter[]>;
  searchResults: LibrivoxSearchResult[];
  searching: boolean;
  searchError: string | null;
  subscribedIds: Set<number>;
  loading: boolean;
  error: string | null;

  fetchSubs: () => Promise<void>;
  subscribe: (result: LibrivoxSearchResult) => Promise<void>;
  unsubscribe: (subId: number) => Promise<void>;
  fetchChapters: (subId: number) => Promise<void>;
  search: (term: string) => Promise<void>;
  clearSearch: () => void;
  refreshCover: (subId: number) => Promise<boolean>;
  setCoverFromUrl: (subId: number, url: string) => Promise<boolean>;
}

export const useAudiobooksStore = create<AudiobooksState>((set, get) => ({
  subscriptions: [],
  chaptersBySub: {},
  searchResults: [],
  searching: false,
  searchError: null,
  subscribedIds: new Set(),
  loading: false,
  error: null,

  fetchSubs: async () => {
    set({ loading: true, error: null });
    try {
      const subs = await audiobookListSubs();
      set({
        subscriptions: subs,
        subscribedIds: new Set(subs.map((s) => s.librivoxId)),
        loading: false,
      });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  subscribe: async (result) => {
    const sub = await audiobookSubscribe(result);
    set((state) => ({
      subscriptions: state.subscriptions.some((s) => s.id === sub.id)
        ? state.subscriptions
        : [...state.subscriptions, sub],
      subscribedIds: new Set([...state.subscribedIds, result.librivoxId]),
    }));
  },

  unsubscribe: async (subId) => {
    const sub = get().subscriptions.find((s) => s.id === subId);
    await audiobookUnsubscribe(subId);
    set((state) => {
      const newIds = new Set(state.subscribedIds);
      if (sub) newIds.delete(sub.librivoxId);
      return {
        subscriptions: state.subscriptions.filter((s) => s.id !== subId),
        subscribedIds: newIds,
        chaptersBySub: Object.fromEntries(
          Object.entries(state.chaptersBySub).filter(([k]) => Number(k) !== subId)
        ),
      };
    });
  },

  fetchChapters: async (subId) => {
    const chapters = await audiobookListChapters(subId);
    set((state) => ({
      chaptersBySub: { ...state.chaptersBySub, [subId]: chapters },
    }));
  },

  search: async (term) => {
    if (!term.trim()) {
      set({ searchResults: [], searching: false, searchError: null });
      return;
    }
    set({ searching: true, searchError: null });
    try {
      const results = await audiobookSearch(term);
      set({ searchResults: results, searching: false });
    } catch (e) {
      set({ searching: false, searchError: (e as Error).message });
    }
  },

  clearSearch: () => set({ searchResults: [], searching: false, searchError: null }),

  refreshCover: async (subId) => {
    const updated = await audiobookRefreshCover(subId);
    if (!updated) return false;
    const found = updated.imageUrl !== null;
    set((state) => ({
      subscriptions: state.subscriptions.map((s) => (s.id === subId ? updated : s)),
    }));
    return found;
  },

  setCoverFromUrl: async (subId, url) => {
    const updated = await audiobookSetCoverFromUrl(subId, url);
    if (!updated) return false;
    set((state) => ({
      subscriptions: state.subscriptions.map((s) => (s.id === subId ? updated : s)),
    }));
    return updated.imageUrl !== null;
  },
}));
