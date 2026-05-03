import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SyncPanel } from "../renderer/components/panels/SyncPanel";
import { SyncProgressModal, SyncCompleteResult } from "../renderer/components/modals/SyncProgressModal";
import { getDevices } from "../renderer/ipc/api";
import { useDeviceStore } from "../renderer/stores/device-store";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  getTracks: vi.fn().mockResolvedValue([]),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  getLibraryStats: vi.fn().mockResolvedValue({ totalTracks: 0 }),
  getDeviceSyncPreferences: vi.fn().mockResolvedValue(null),
  startSync: vi.fn().mockResolvedValue({ synced: 0, errors: 0 }),
  cancelSync: vi.fn().mockResolvedValue(undefined),
  onSyncProgress: vi.fn(() => () => {}),
}));

describe("SyncPanel", () => {
  beforeEach(() => {
    useDeviceStore.setState({ devices: [], loading: false, error: null });
  });

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

  it("shows auto podcasts notice when selected device has autoPodcastsEnabled", async () => {
    vi.mocked(getDevices).mockResolvedValueOnce([
      {
        id: 7,
        name: "My Podcast Player",
        mountPath: "/mnt/podcast",
        musicFolder: "Music",
        podcastFolder: "Podcasts",
        audiobookFolder: "Audiobooks",
        playlistFolder: "Playlists",
        modelId: null,
        defaultCodecConfigId: null,
        description: null,
        lastSyncDate: null,
        totalSyncedItems: 0,
        lastSyncCount: 0,
        defaultTransferModeId: 1,
        overrideBitrate: null,
        overrideQuality: null,
        overrideBits: null,
        partialSyncEnabled: false,
        sourceLibraryType: "primary",
        shadowLibraryId: null,
        transferModeName: null,
        codecConfigName: null,
        codecConfigBitrate: null,
        codecConfigQuality: null,
        codecConfigBits: null,
        codecName: "DIRECT COPY",
        modelName: null,
        modelInternalValue: null,
        autoPodcastsEnabled: true,
      } as never,
    ]);

    render(<SyncPanel />);

    await waitFor(() => {
      expect(screen.getByText("My Podcast Player")).toBeInTheDocument();
    });

    expect(screen.getByText(/Auto Podcasts enabled/)).toBeInTheDocument();
    expect(screen.getByText(/new episodes sync to this device automatically/)).toBeInTheDocument();
  });

  it("does not show auto podcasts notice when no device is selected", () => {
    vi.mocked(getDevices).mockResolvedValue([]);
    render(<SyncPanel />);
    expect(screen.queryByText(/Auto Podcasts enabled/)).not.toBeInTheDocument();
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
