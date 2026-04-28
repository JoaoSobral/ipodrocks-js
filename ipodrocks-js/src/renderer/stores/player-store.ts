import { create } from "zustand";
import { preparePlayback } from "../ipc/api";
import { safeLocalStorage } from "../utils/storage";
import type { Track } from "../ipc/api";

const VOLUME_KEY = "ipodrocks_player_volume";
const MUTE_KEY = "ipodrocks_player_muted";

function loadVolume(): number {
  const v = safeLocalStorage()?.getItem(VOLUME_KEY);
  return v != null ? Math.min(1, Math.max(0, parseFloat(v))) : 0.8;
}

function loadMuted(): boolean {
  return safeLocalStorage()?.getItem(MUTE_KEY) === "true";
}

export interface PlayerState {
  currentTrack: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  sourceUrl: string | null;
  strategy: "native" | "transcode" | null;
  isPreparing: boolean;

  playTrack: (track: Track, queue: Track[]) => Promise<void>;
  togglePlayPause: () => void;
  stop: () => void;
  dismiss: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  seek: (t: number) => void;
  retryAsTranscode: () => Promise<void>;
  _setIsPlaying: (v: boolean) => void;
  _setCurrentTime: (t: number) => void;
  _setDuration: (d: number) => void;
  _onEnded: () => void;
}

async function runPrepare(
  track: Track,
  forceTranscode: boolean,
  set: (partial: Partial<PlayerState>) => void,
  extraOnSuccess?: Partial<PlayerState>,
): Promise<void> {
  try {
    const { url, strategy } = await (forceTranscode ? preparePlayback(track, true) : preparePlayback(track));
    set({ sourceUrl: url, strategy, isPreparing: false, ...extraOnSuccess });
  } catch (e) {
    set({ isPreparing: false });
    console.error(`player:prepare${forceTranscode ? " (transcode)" : ""} failed`, e);
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: loadVolume(),
  isMuted: loadMuted(),
  sourceUrl: null,
  strategy: null,
  isPreparing: false,

  playTrack: async (track, queue) => {
    const index = queue.findIndex((t) => t.id === track.id);
    set({ currentTrack: track, queue, queueIndex: index, isPreparing: true, sourceUrl: null, currentTime: 0, isPlaying: false });
    await runPrepare(track, false, set);
  },

  togglePlayPause: () => {
    set((s) => ({ isPlaying: !s.isPlaying }));
  },

  stop: () => {
    set({ isPlaying: false, currentTime: 0 });
  },

  dismiss: () => {
    set({
      currentTrack: null,
      queue: [],
      queueIndex: -1,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      sourceUrl: null,
      strategy: null,
      isPreparing: false,
    });
  },

  next: async () => {
    const { queue, queueIndex, playTrack } = get();
    if (queueIndex < queue.length - 1) {
      await playTrack(queue[queueIndex + 1], queue);
    } else {
      set({ isPlaying: false });
    }
  },

  previous: async () => {
    const { queue, queueIndex, currentTime, playTrack } = get();
    if (currentTime > 3) {
      set({ currentTime: 0 });
    } else if (queueIndex > 0) {
      await playTrack(queue[queueIndex - 1], queue);
    }
  },

  setVolume: (v) => {
    const clamped = Math.min(1, Math.max(0, v));
    safeLocalStorage()?.setItem(VOLUME_KEY, String(clamped));
    set({ volume: clamped });
  },

  toggleMute: () => {
    set((s) => {
      const next = !s.isMuted;
      safeLocalStorage()?.setItem(MUTE_KEY, String(next));
      return { isMuted: next };
    });
  },

  seek: (t) => {
    set({ currentTime: t });
  },

  retryAsTranscode: async () => {
    const { currentTrack, queue } = get();
    if (!currentTrack) return;
    const index = queue.findIndex((t) => t.id === currentTrack.id);
    set({ isPreparing: true, sourceUrl: null });
    await runPrepare(currentTrack, true, set, { queueIndex: index });
  },

  _setIsPlaying: (v) => set({ isPlaying: v }),
  _setCurrentTime: (t) => set({ currentTime: t }),
  _setDuration: (d) => set({ duration: d }),
  _onEnded: () => { get().next(); },
}));
