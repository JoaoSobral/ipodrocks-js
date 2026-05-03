import { create } from "zustand";
import type { PodcastSubscription, PodcastEpisode, PodcastSearchResult } from "../ipc/api";
import {
  podcastListSubs,
  podcastSubscribeFeed,
  podcastUnsubscribe,
  podcastSetAutoCount,
  podcastListEpisodes,
  podcastSetManualSelection,
  podcastDownloadNow,
  podcastSearch,
} from "../ipc/api";

interface PodcastsState {
  subscriptions: PodcastSubscription[];
  episodesBySub: Record<number, PodcastEpisode[]>;
  searchResults: PodcastSearchResult[];
  searching: boolean;
  searchError: string | null;
  subscribedFeedIds: Set<number>;
  loading: boolean;
  error: string | null;

  fetchSubs: () => Promise<void>;
  subscribe: (feed: PodcastSearchResult) => Promise<void>;
  unsubscribe: (subId: number) => Promise<void>;
  setAutoCount: (subId: number, count: number) => Promise<void>;
  fetchEpisodes: (subId: number) => Promise<void>;
  setManualSelection: (subId: number, episodeIds: number[]) => Promise<void>;
  downloadNow: (subId: number) => Promise<{ ok?: boolean; error?: string }>;
  search: (term: string) => Promise<void>;
  clearSearch: () => void;
}

export const usePodcastsStore = create<PodcastsState>((set, get) => ({
  subscriptions: [],
  episodesBySub: {},
  searchResults: [],
  searching: false,
  searchError: null,
  subscribedFeedIds: new Set(),
  loading: false,
  error: null,

  fetchSubs: async () => {
    set({ loading: true, error: null });
    try {
      const subs = await podcastListSubs();
      set({
        subscriptions: subs,
        subscribedFeedIds: new Set(subs.map((s) => s.feedId)),
        loading: false,
      });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  subscribe: async (feed) => {
    const sub = await podcastSubscribeFeed(feed);
    set((state) => ({
      subscriptions: [...state.subscriptions, sub],
      subscribedFeedIds: new Set([...state.subscribedFeedIds, feed.feedId]),
    }));
  },

  unsubscribe: async (subId) => {
    await podcastUnsubscribe(subId);
    set((state) => {
      const sub = state.subscriptions.find((s) => s.id === subId);
      const newFeedIds = new Set(state.subscribedFeedIds);
      if (sub) newFeedIds.delete(sub.feedId);
      return {
        subscriptions: state.subscriptions.filter((s) => s.id !== subId),
        subscribedFeedIds: newFeedIds,
      };
    });
  },

  setAutoCount: async (subId, count) => {
    await podcastSetAutoCount(subId, count);
    set((state) => ({
      subscriptions: state.subscriptions.map((s) =>
        s.id === subId ? { ...s, autoCount: count } : s
      ),
    }));
  },

  fetchEpisodes: async (subId) => {
    const episodes = await podcastListEpisodes(subId);
    set((state) => ({
      episodesBySub: { ...state.episodesBySub, [subId]: episodes },
    }));
  },

  setManualSelection: async (subId, episodeIds) => {
    await podcastSetManualSelection(subId, episodeIds);
    set((state) => ({
      episodesBySub: {
        ...state.episodesBySub,
        [subId]: (state.episodesBySub[subId] ?? []).map((ep) => ({
          ...ep,
          manualSelected: episodeIds.includes(ep.id),
        })),
      },
    }));
  },

  downloadNow: async (subId) => {
    const result = await podcastDownloadNow(subId);
    if (!("error" in result)) {
      // Refresh episode list after download
      await get().fetchEpisodes(subId);
    }
    return result;
  },

  search: async (term) => {
    if (!term.trim()) {
      set({ searchResults: [], searching: false, searchError: null });
      return;
    }
    set({ searching: true, searchError: null });
    try {
      const results = await podcastSearch(term);
      if ("error" in results) {
        set({ searchResults: [], searching: false, searchError: results.error });
      } else {
        set({ searchResults: results, searching: false });
      }
    } catch (e) {
      set({ searching: false, searchError: (e as Error).message });
    }
  },

  clearSearch: () => set({ searchResults: [], searching: false, searchError: null }),
}));
