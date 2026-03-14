import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LibraryPanel } from "../renderer/components/panels/LibraryPanel";

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
  clearContentHashes: vi.fn().mockResolvedValue(undefined),
  pickFolder: vi.fn().mockResolvedValue({ path: null }),
  createShadowLibrary: vi.fn().mockResolvedValue(undefined),
  deleteShadowLibrary: vi.fn().mockResolvedValue(undefined),
  rebuildShadowLibrary: vi.fn().mockResolvedValue(undefined),
  cancelShadowBuild: vi.fn().mockResolvedValue(undefined),
  onShadowBuildProgress: vi.fn().mockReturnValue(() => {}),
  isMpcencAvailable: vi.fn().mockResolvedValue(false),
  getMpcRemindDisabled: vi.fn().mockResolvedValue(false),
  setMpcRemindDisabled: vi.fn().mockResolvedValue(undefined),
  checkSavantKeyData: vi.fn().mockResolvedValue({
    keyedCount: 0,
    totalCount: 0,
    coveragePct: 0,
    bpmOnlyCount: 0,
  }),
}));

vi.mock("../renderer/stores/ui-store", () => ({
  useUIStore: vi.fn().mockReturnValue(null),
}));

describe("LibraryPanel", () => {
  it("renders library panel", () => {
    render(<LibraryPanel />);
    expect(screen.getByPlaceholderText(/Search by title/)).toBeInTheDocument();
  });
});
