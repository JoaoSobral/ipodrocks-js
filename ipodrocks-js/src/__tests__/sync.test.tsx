import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SyncPanel } from "../renderer/components/panels/SyncPanel";
import { SyncProgressModal, SyncCompleteResult } from "../renderer/components/modals/SyncProgressModal";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  getTracks: vi.fn().mockResolvedValue([]),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  getLibraryStats: vi.fn().mockResolvedValue({ totalTracks: 0 }),
  startSync: vi.fn().mockResolvedValue({ synced: 0, errors: 0 }),
  cancelSync: vi.fn().mockResolvedValue(undefined),
  onSyncProgress: vi.fn(() => () => {}),
}));

describe("SyncPanel", () => {
  it("renders sync panel", () => {
    render(<SyncPanel />);
    expect(screen.getByText("Target Device")).toBeInTheDocument();
    expect(screen.getByText("Sync Configuration")).toBeInTheDocument();
  });

  it("renders Not syncing album artwork checkbox and defaults unchecked", () => {
    render(<SyncPanel />);
    const checkbox = screen.getByLabelText("Not syncing album artwork");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });
});

describe("SyncCompleteResult interface", () => {
  it("includes skippedBreakdown with all content types", () => {
    const result: SyncCompleteResult = {
      synced: 2765,
      skipped: 260,
      errors: 0,
      status: "success",
      skippedBreakdown: {
        music: 0,
        podcast: 0,
        audiobook: 0,
        artwork: 260,
        playlist: 0,
      },
    };
    expect(result.skippedBreakdown.artwork).toBe(260);
    expect(result.skippedBreakdown.music).toBe(0);
  });
});
