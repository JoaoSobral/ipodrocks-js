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

import { fireEvent, waitFor } from "@testing-library/react";

describe("PlaylistPanel", () => {
  it("renders playlist panel", () => {
    render(<PlaylistPanel />);
    expect(screen.getByText("+ Create Playlist")).toBeInTheDocument();
  });

  it("shows name hint and turns selection hint blue when smart create submitted empty", async () => {
    render(<PlaylistPanel />);
    fireEvent.click(screen.getByText("+ Create Playlist"));

    // Pick "Smart Playlist" from the type chooser
    await waitFor(() => {
      expect(screen.getByText("Smart Playlist")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Smart Playlist"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("My Playlist")).toBeInTheDocument();
    });

    const createBtn = screen.getByRole("button", { name: "Create" });
    expect(createBtn).not.toBeDisabled();
    fireEvent.click(createBtn);

    expect(screen.getByText("Please enter a playlist name")).toBeInTheDocument();
    // The "Select genres, artists, or albums" text should now be blue (text-blue-500 class)
    const selectionHint = screen.getByText("Select genres, artists, or albums to build your playlist.");
    expect(selectionHint).toHaveClass("text-blue-500");
  });

  it("shows only selection hint when name is filled but no selections made", async () => {
    render(<PlaylistPanel />);
    fireEvent.click(screen.getByText("+ Create Playlist"));

    await waitFor(() => {
      expect(screen.getByText("Smart Playlist")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Smart Playlist"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("My Playlist")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("My Playlist"), {
      target: { value: "My Smart Playlist" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.queryByText("Please enter a playlist name")).not.toBeInTheDocument();
    const selectionHint = screen.getByText("Select genres, artists, or albums to build your playlist.");
    expect(selectionHint).toHaveClass("text-blue-500");
  });
});
