import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlaylistPanel } from "../renderer/components/panels/PlaylistPanel";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  createPlaylist: vi.fn().mockResolvedValue(undefined),
  deletePlaylist: vi.fn().mockResolvedValue(undefined),
  exportPlaylist: vi.fn().mockResolvedValue(undefined),
  getGenres: vi.fn().mockResolvedValue([]),
  getArtists: vi.fn().mockResolvedValue([]),
  getAlbums: vi.fn().mockResolvedValue([]),
  analyzeDevicePlayback: vi.fn().mockResolvedValue({}),
  getGeniusTypes: vi.fn().mockResolvedValue([]),
  generateGeniusPlaylist: vi.fn().mockResolvedValue({}),
  saveGeniusPlaylist: vi.fn().mockResolvedValue(undefined),
  generateSavantPlaylist: vi.fn().mockResolvedValue({}),
  checkSavantKeyData: vi.fn().mockResolvedValue({
    keyedCount: 0,
    totalCount: 0,
    coveragePct: 0,
    bpmOnlyCount: 0,
  }),
  backfillSavantFeatures: vi.fn().mockResolvedValue(undefined),
  getOpenRouterConfig: vi.fn().mockResolvedValue(null),
}));

describe("PlaylistPanel", () => {
  it("renders playlist panel", () => {
    render(<PlaylistPanel />);
    expect(screen.getByText("+ Create Playlist")).toBeInTheDocument();
  });
});
