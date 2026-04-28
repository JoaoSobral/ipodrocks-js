import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlayerBar } from "../renderer/components/player/PlayerBar";
import { usePlayerStore } from "../renderer/stores/player-store";

// Mock the IPC api module
vi.mock("../renderer/ipc/api", () => ({
  preparePlayback: vi.fn().mockResolvedValue({ url: "media://local/abc", strategy: "native" }),
  cancelPlayback: vi.fn().mockResolvedValue(undefined),
}));

// JSDOM doesn't implement HTMLMediaElement methods
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: vi.fn().mockResolvedValue(undefined),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLMediaElement.prototype, "load", {
  configurable: true,
  value: vi.fn(),
});

const baseTrack = {
  id: 1,
  path: "/music/song.mp3",
  filename: "song.mp3",
  title: "Test Song",
  artist: "Test Artist",
  album: "Test Album",
  genre: "Rock",
  codec: "MP3",
  duration: 200,
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
};

describe("PlayerBar", () => {
  beforeEach(() => {
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
  });

  it("renders nothing when no track is loaded", () => {
    const { container } = render(<PlayerBar />);
    expect(container.firstChild).toBeNull();
  });

  it("renders track title and artist when a track is set", () => {
    usePlayerStore.setState({ currentTrack: baseTrack as any, sourceUrl: "media://local/abc" });
    render(<PlayerBar />);
    expect(screen.getByText("Test Song")).toBeTruthy();
    expect(screen.getByText("Test Artist")).toBeTruthy();
  });

  it("clicking play/pause toggles isPlaying in the store", () => {
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      isPlaying: false,
    });
    render(<PlayerBar />);
    const playBtn = screen.getByTitle("Play");
    fireEvent.click(playBtn);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("clicking stop resets currentTime to 0", () => {
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      isPlaying: true,
      currentTime: 90,
    });
    render(<PlayerBar />);
    const stopBtn = screen.getByTitle("Stop");
    fireEvent.click(stopBtn);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().currentTime).toBe(0);
  });

  it("volume slider updates store volume", () => {
    usePlayerStore.setState({ currentTrack: baseTrack as any, sourceUrl: "media://local/abc" });
    render(<PlayerBar />);
    const volumeSlider = screen.getByTitle(/^Volume/);
    fireEvent.change(volumeSlider, { target: { value: "0.5" } });
    expect(usePlayerStore.getState().volume).toBe(0.5);
  });

  it("mute toggle changes isMuted", () => {
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      isMuted: false,
    });
    render(<PlayerBar />);
    const muteBtn = screen.getByTitle("Mute");
    fireEvent.click(muteBtn);
    expect(usePlayerStore.getState().isMuted).toBe(true);
  });

  it("clicking the close button dismisses the player (clears currentTrack)", () => {
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      isPlaying: true,
      queue: [baseTrack as any],
      queueIndex: 0,
    });
    render(<PlayerBar />);
    const closeBtn = screen.getByTitle("Close player");
    fireEvent.click(closeBtn);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().sourceUrl).toBeNull();
  });

  it("setting sourceUrl does not call pause() while isPlaying is false", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause");
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: null,
      isPlaying: false,
    });
    render(<PlayerBar />);
    // Simulate preparePlayback resolving — source URL arrives while isPlaying=false
    usePlayerStore.setState({ sourceUrl: "media://local/abc" });
    // pause() must not be called; that would abort the pending play() promise
    expect(pauseSpy).not.toHaveBeenCalled();
    pauseSpy.mockRestore();
  });

  it("onTimeUpdate only updates store when change is >= 0.25s", () => {
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      currentTime: 0,
    });
    render(<PlayerBar />);
    const audio = document.querySelector("audio")!;

    // Small change (< 0.25s) — should NOT update store
    fireEvent.timeUpdate(audio, { target: { currentTime: 0.1 } });
    expect(usePlayerStore.getState().currentTime).toBe(0);

    // Change >= 0.25s — should update store
    fireEvent.timeUpdate(audio, { target: { currentTime: 10 } });
    expect(usePlayerStore.getState().currentTime).toBe(10);

    // Another small change from 10 — should NOT update
    fireEvent.timeUpdate(audio, { target: { currentTime: 10.1 } });
    expect(usePlayerStore.getState().currentTime).toBe(10);
  });

  it("play() is not called redundantly when audio is already playing", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play");
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get: () => false, // audio is already playing
    });
    usePlayerStore.setState({
      currentTrack: baseTrack as any,
      sourceUrl: "media://local/abc",
      isPlaying: true,
    });
    render(<PlayerBar />);
    playSpy.mockClear();
    // Triggering isPlaying=true again (e.g. onPlay feedback) must not call play()
    usePlayerStore.getState()._setIsPlaying(true);
    expect(playSpy).not.toHaveBeenCalled();
    playSpy.mockRestore();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get: () => true,
    });
  });
});
