/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub localStorage before any module loads that might reference it
const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { for (const k of Object.keys(localStorageStore)) delete localStorageStore[k]; },
};
vi.stubGlobal("localStorage", localStorageMock);

// Mock the IPC api module
vi.mock("../renderer/ipc/api", () => ({
  preparePlayback: vi.fn().mockResolvedValue({ url: "media://local/abc", strategy: "native" }),
  cancelPlayback: vi.fn().mockResolvedValue(undefined),
}));

import { usePlayerStore } from "../renderer/stores/player-store";
import * as api from "../renderer/ipc/api";
import type { Track } from "../shared/types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    path: "/music/song.mp3",
    filename: "song.mp3",
    title: "Song",
    artist: "Artist",
    album: "Album",
    genre: "Rock",
    codec: "MP3",
    duration: 180,
    bitrate: 320000,
    bitsPerSample: 16,
    fileSize: 5_000_000,
    contentType: "music",
    libraryFolderId: 1,
    fileHash: "abc",
    metadataHash: "def",
    trackNumber: 1,
    discNumber: 1,
    playCount: 0,
    rating: null,
    ratingSourceDeviceId: null,
    ratingUpdatedAt: null,
    ratingVersion: 0,
    ...overrides,
  } as Track;
}

describe("player-store", () => {
  beforeEach(() => {
    localStorageMock.clear();
    // Reset store to initial state
    usePlayerStore.setState({
      currentTrack: null,
      queue: [],
      queueIndex: -1,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 0.8,
      isMuted: false,
      sourceUrl: null,
      strategy: null,
      isPreparing: false,
    });
    vi.clearAllMocks();
    vi.mocked(api.preparePlayback).mockResolvedValue({ url: "media://local/abc", strategy: "native" });
  });

  describe("playTrack", () => {
    it("sets currentTrack, queue, and queueIndex", async () => {
      const t1 = makeTrack({ id: 1 });
      const t2 = makeTrack({ id: 2, path: "/music/t2.mp3" });
      const queue = [t1, t2];

      await usePlayerStore.getState().playTrack(t1, queue);

      const s = usePlayerStore.getState();
      expect(s.currentTrack).toEqual(t1);
      expect(s.queue).toEqual(queue);
      expect(s.queueIndex).toBe(0);
      expect(s.sourceUrl).toBe("media://local/abc");
      expect(s.strategy).toBe("native");
      expect(s.isPreparing).toBe(false);
    });

    it("calls preparePlayback with the track", async () => {
      const t = makeTrack();
      await usePlayerStore.getState().playTrack(t, [t]);
      expect(api.preparePlayback).toHaveBeenCalledWith(t);
    });

    it("resets currentTime to 0 when switching tracks", async () => {
      usePlayerStore.setState({ currentTime: 120 });
      const t = makeTrack();
      await usePlayerStore.getState().playTrack(t, [t]);
      expect(usePlayerStore.getState().currentTime).toBe(0);
    });

    it("handles preparePlayback failure gracefully", async () => {
      vi.mocked(api.preparePlayback).mockRejectedValue(new Error("network error"));
      const t = makeTrack();
      await usePlayerStore.getState().playTrack(t, [t]);
      const s = usePlayerStore.getState();
      expect(s.isPreparing).toBe(false);
      expect(s.sourceUrl).toBeNull();
    });
  });

  describe("togglePlayPause", () => {
    it("toggles isPlaying", () => {
      usePlayerStore.setState({ isPlaying: false });
      usePlayerStore.getState().togglePlayPause();
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      usePlayerStore.getState().togglePlayPause();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    });
  });

  describe("stop", () => {
    it("pauses and resets currentTime to 0", () => {
      usePlayerStore.setState({ isPlaying: true, currentTime: 90 });
      usePlayerStore.getState().stop();
      const s = usePlayerStore.getState();
      expect(s.isPlaying).toBe(false);
      expect(s.currentTime).toBe(0);
    });
  });

  describe("next", () => {
    it("advances to next track in queue", async () => {
      const t1 = makeTrack({ id: 1 });
      const t2 = makeTrack({ id: 2, path: "/music/t2.mp3" });
      usePlayerStore.setState({ queue: [t1, t2], queueIndex: 0, currentTrack: t1 });
      await usePlayerStore.getState().next();
      expect(usePlayerStore.getState().currentTrack).toEqual(t2);
    });

    it("stops at end of queue", async () => {
      const t1 = makeTrack({ id: 1 });
      usePlayerStore.setState({ queue: [t1], queueIndex: 0, currentTrack: t1, isPlaying: true });
      await usePlayerStore.getState().next();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    });
  });

  describe("previous", () => {
    it("goes to previous track when currentTime <= 3", async () => {
      const t1 = makeTrack({ id: 1 });
      const t2 = makeTrack({ id: 2, path: "/music/t2.mp3" });
      usePlayerStore.setState({ queue: [t1, t2], queueIndex: 1, currentTrack: t2, currentTime: 1 });
      await usePlayerStore.getState().previous();
      expect(usePlayerStore.getState().currentTrack).toEqual(t1);
    });

    it("resets to start if currentTime > 3", async () => {
      const t1 = makeTrack({ id: 1 });
      const t2 = makeTrack({ id: 2, path: "/music/t2.mp3" });
      usePlayerStore.setState({ queue: [t1, t2], queueIndex: 1, currentTrack: t2, currentTime: 60 });
      await usePlayerStore.getState().previous();
      expect(usePlayerStore.getState().currentTime).toBe(0);
      expect(usePlayerStore.getState().currentTrack).toEqual(t2);
    });
  });

  describe("setVolume", () => {
    it("clamps to 0..1 and persists to localStorage", () => {
      usePlayerStore.getState().setVolume(1.5);
      expect(usePlayerStore.getState().volume).toBe(1);
      expect(localStorageMock.getItem("ipodrocks_player_volume")).toBe("1");

      usePlayerStore.getState().setVolume(-0.5);
      expect(usePlayerStore.getState().volume).toBe(0);
    });

    it("sets mid-range value correctly", () => {
      usePlayerStore.getState().setVolume(0.42);
      expect(usePlayerStore.getState().volume).toBe(0.42);
    });
  });

  describe("toggleMute", () => {
    it("toggles isMuted and persists", () => {
      usePlayerStore.setState({ isMuted: false });
      usePlayerStore.getState().toggleMute();
      expect(usePlayerStore.getState().isMuted).toBe(true);
      expect(localStorageMock.getItem("ipodrocks_player_muted")).toBe("true");
      usePlayerStore.getState().toggleMute();
      expect(usePlayerStore.getState().isMuted).toBe(false);
    });
  });

  describe("dismiss", () => {
    it("clears currentTrack, sourceUrl, queue, and stops playback", () => {
      const t = makeTrack();
      usePlayerStore.setState({
        currentTrack: t,
        queue: [t],
        queueIndex: 0,
        isPlaying: true,
        currentTime: 60,
        duration: 180,
        sourceUrl: "media://local/abc",
        strategy: "native",
        isPreparing: false,
      });
      usePlayerStore.getState().dismiss();
      const s = usePlayerStore.getState();
      expect(s.currentTrack).toBeNull();
      expect(s.sourceUrl).toBeNull();
      expect(s.queue).toEqual([]);
      expect(s.queueIndex).toBe(-1);
      expect(s.isPlaying).toBe(false);
      expect(s.currentTime).toBe(0);
    });
  });

  describe("auto-advance (_onEnded)", () => {
    it("calls next when a track ends", async () => {
      const t1 = makeTrack({ id: 1 });
      const t2 = makeTrack({ id: 2, path: "/music/t2.mp3" });
      usePlayerStore.setState({ queue: [t1, t2], queueIndex: 0, currentTrack: t1 });
      await usePlayerStore.getState()._onEnded();
      expect(usePlayerStore.getState().currentTrack).toEqual(t2);
    });
  });
});
