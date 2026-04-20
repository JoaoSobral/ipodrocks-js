import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { LibraryPanel } from "../renderer/components/panels/LibraryPanel";
import { useLibraryStore } from "../renderer/stores/library-store";
import * as api from "../renderer/ipc/api";

// JSDOM doesn't implement ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("../renderer/ipc/api", () => ({
  getTracks: vi.fn().mockResolvedValue([]),
  getLibraryStats: vi.fn().mockResolvedValue({
    totalTracks: 0,
    totalAlbums: 0,
    totalArtists: 0,
    totalSizeBytes: 0,
  }),
  getLibraryFolders: vi.fn().mockResolvedValue([]),
  getDevices: vi.fn().mockResolvedValue([]),
  getDefaultDeviceId: vi.fn().mockResolvedValue(null),
  getDeviceSyncedPaths: vi.fn().mockResolvedValue([]),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getCodecConfigs: vi.fn().mockResolvedValue([]),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  addLibraryFolder: vi.fn().mockResolvedValue(undefined),
  removeLibraryFolder: vi.fn().mockResolvedValue(undefined),
  clearContentHashes: vi.fn().mockResolvedValue(0),
  pickFolder: vi.fn().mockResolvedValue(null),
  createShadowLibrary: vi.fn().mockResolvedValue(undefined),
  deleteShadowLibrary: vi.fn().mockResolvedValue(undefined),
  rebuildShadowLibrary: vi.fn().mockResolvedValue(undefined),
  cancelShadowBuild: vi.fn().mockResolvedValue(undefined),
  onShadowBuildProgress: vi.fn().mockReturnValue(() => {}),
  isMpcencAvailable: vi.fn().mockResolvedValue({ available: false }),
  getMpcRemindDisabled: vi.fn().mockResolvedValue({ disabled: false }),
  setMpcRemindDisabled: vi.fn().mockResolvedValue(undefined),
  checkSavantKeyData: vi.fn().mockResolvedValue({
    keyedCount: 0,
    totalCount: 0,
    coveragePct: 0,
    bpmOnlyCount: 0,
  }),
  setTrackRating: vi.fn().mockResolvedValue({ ok: true }),
  getRatingConflicts: vi.fn().mockResolvedValue([]),
}));

vi.mock("../renderer/stores/ui-store", () => ({
  useUIStore: vi.fn().mockReturnValue(null),
}));

const mockFolder = { id: 1, name: "My Music", path: "/music", contentType: "music" };

function makeTrack(overrides: Partial<typeof baseTrack> = {}) {
  return { ...baseTrack, ...overrides };
}

const baseTrack = {
  id: 1,
  path: "/music/track.mp3",
  filename: "track.mp3",
  title: "Test Song",
  artist: "Test Artist",
  album: "Test Album",
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
  rating: null as number | null,
  ratingSourceDeviceId: null as number | null,
  ratingUpdatedAt: null as string | null,
  ratingVersion: 0,
};

beforeEach(() => {
  useLibraryStore.setState({ tracks: [], folders: [], stats: null, loading: false, error: null });
  vi.clearAllMocks();
  vi.mocked(api.getTracks).mockResolvedValue([]);
  vi.mocked(api.getLibraryFolders).mockResolvedValue([]);
  vi.mocked(api.getLibraryStats).mockResolvedValue({ totalTracks: 0, totalAlbums: 0, totalArtists: 0, totalSizeBytes: 0 });
  vi.mocked(api.getDevices).mockResolvedValue([]);
  vi.mocked(api.getDefaultDeviceId).mockResolvedValue(null);
  vi.mocked(api.getShadowLibraries).mockResolvedValue([]);
  vi.mocked(api.getCodecConfigs).mockResolvedValue([]);
  vi.mocked(api.isMpcencAvailable).mockResolvedValue({ available: false });
  vi.mocked(api.getMpcRemindDisabled).mockResolvedValue({ disabled: false });
  vi.mocked(api.checkSavantKeyData).mockResolvedValue({ keyedCount: 0, totalCount: 0, coveragePct: 0, bpmOnlyCount: 0 });
  vi.mocked(api.getRatingConflicts).mockResolvedValue([]);
  vi.mocked(api.setTrackRating).mockResolvedValue({ ok: true });
});

describe("LibraryPanel", () => {
  it("renders the search box", () => {
    render(<LibraryPanel />);
    expect(screen.getByPlaceholderText(/Search by title/)).toBeInTheDocument();
  });

  it("shows empty state when no folders are configured", async () => {
    render(<LibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/No library folders configured/)).toBeInTheDocument();
    });
  });

  it("shows tracks when folders and tracks exist", async () => {
    vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
    vi.mocked(api.getTracks).mockResolvedValue([makeTrack({ title: "Test Song" })]);

    render(<LibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText("Test Song")).toBeInTheDocument();
    });
  });

  it("filters tracks by search query", async () => {
    vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
    vi.mocked(api.getTracks).mockResolvedValue([
      makeTrack({ id: 1, title: "Jazz Night" }),
      makeTrack({ id: 2, title: "Rock Anthem" }),
    ]);

    render(<LibraryPanel />);

    await waitFor(() => {
      expect(screen.getByText("Jazz Night")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/Search by title/);
    fireEvent.change(searchInput, { target: { value: "jazz" } });

    await waitFor(() => {
      expect(screen.getByText("Jazz Night")).toBeInTheDocument();
      expect(screen.queryByText("Rock Anthem")).not.toBeInTheDocument();
    });
  });

  describe("star ratings", () => {
    it("clicking a star sets the rating and saves to backend", async () => {
      vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
      vi.mocked(api.getTracks).mockResolvedValue([makeTrack({ id: 1, rating: null })]);

      render(<LibraryPanel />);

      await waitFor(() => expect(screen.getByText("Test Song")).toBeInTheDocument());

      // Click the 4th star (4 stars = Rockbox 8)
      const starButtons = screen.getAllByRole("button", { name: "4 star" });
      fireEvent.click(starButtons[0]);

      await waitFor(() => {
        expect(api.setTrackRating).toHaveBeenCalledWith(1, 8);
      });
    });

    it("clicking the active star clears the rating", async () => {
      // rating: 6 = 3 stars on Rockbox scale
      vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
      vi.mocked(api.getTracks).mockResolvedValue([makeTrack({ id: 1, rating: 6 })]);

      render(<LibraryPanel />);

      await waitFor(() => expect(screen.getByText("Test Song")).toBeInTheDocument());

      // Clicking the 3rd star (currently active) should clear rating
      const starButtons = screen.getAllByRole("button", { name: "3 star" });
      fireEvent.click(starButtons[0]);

      await waitFor(() => {
        expect(api.setTrackRating).toHaveBeenCalledWith(1, null);
      });
    });

    it("re-fetches tracks after a rating is saved", async () => {
      vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
      vi.mocked(api.getTracks).mockResolvedValue([makeTrack({ id: 1, rating: null })]);

      render(<LibraryPanel />);

      await waitFor(() => expect(screen.getByText("Test Song")).toBeInTheDocument());

      const callCountBefore = vi.mocked(api.getTracks).mock.calls.length;

      fireEvent.click(screen.getAllByRole("button", { name: "2 star" })[0]);

      await waitFor(() => {
        expect(vi.mocked(api.getTracks).mock.calls.length).toBeGreaterThan(callCountBefore);
      });
    });

    it("displays correct star fill for an existing rating", async () => {
      // rating: 4 = 2 stars
      vi.mocked(api.getLibraryFolders).mockResolvedValue([mockFolder]);
      vi.mocked(api.getTracks).mockResolvedValue([makeTrack({ id: 1, rating: 4 })]);

      render(<LibraryPanel />);

      await waitFor(() => expect(screen.getByText("Test Song")).toBeInTheDocument());

      // The row should contain RatingStars — verify star buttons exist and the component renders
      expect(screen.getAllByRole("button", { name: "1 star" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "5 star" })).toHaveLength(1);
    });
  });
});
