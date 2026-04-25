import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DevicePanel } from "../renderer/components/panels/DevicePanel";
import { getDevices, checkDevice } from "../renderer/ipc/api";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  addDevice: vi.fn().mockResolvedValue(undefined),
  updateDevice: vi.fn().mockResolvedValue(undefined),
  removeDevice: vi.fn().mockResolvedValue(undefined),
  checkDevice: vi.fn().mockResolvedValue({}),
  pickFolder: vi.fn().mockResolvedValue({ path: null }),
  getDeviceModels: vi.fn().mockResolvedValue([]),
  getCodecConfigs: vi.fn().mockResolvedValue([]),
  setDefaultDevice: vi.fn().mockResolvedValue(undefined),
  getDefaultDeviceId: vi.fn().mockResolvedValue(null),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  isMpcencAvailable: vi.fn().mockResolvedValue(false),
  getMpcRemindDisabled: vi.fn().mockResolvedValue(false),
  setMpcRemindDisabled: vi.fn().mockResolvedValue(undefined),
  pingDevice: vi.fn().mockResolvedValue({ online: false }),
}));

describe("DevicePanel", () => {
  it("renders device panel", () => {
    render(<DevicePanel />);
    expect(screen.getByText("+ Add Device")).toBeInTheDocument();
  });

  it("shows codec mismatch and to-sync counts when check result includes them", async () => {
    vi.mocked(getDevices).mockResolvedValueOnce([
      {
        id: 1,
        name: "Test iPod",
        mountPath: "/mnt/ipod",
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
        codecConfigName: "OPUS",
        codecConfigBitrate: null,
        codecConfigQuality: null,
        codecConfigBits: null,
        codecName: "OPUS",
        modelName: null,
        modelInternalValue: null,
      } as never,
    ]);

    vi.mocked(checkDevice).mockResolvedValueOnce({
      deviceId: 1,
      name: "Test iPod",
      music: { fileCount: 10, totalGb: 0.5 },
      podcasts: { fileCount: 0, totalGb: 0 },
      disk: { totalBytes: 0, freeBytes: 0, totalGb: 0, freeGb: 0 },
      musicSyncedWithLibrary: 3,
      musicOrphans: 1,
      musicCodecMismatch: 5,
      musicToSync: 2,
      podcastSyncedWithLibrary: 0,
      podcastOrphans: 0,
      audiobookSyncedWithLibrary: 0,
      audiobookOrphans: 0,
      profileCodecName: "OPUS",
    });

    render(<DevicePanel />);

    await waitFor(() => {
      expect(screen.getByText("Test iPod")).toBeInTheDocument();
    });

    const checkButton = screen.getByRole("button", { name: /Check Device/i });
    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(screen.getByText(/5 codec mismatch/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Codec mismatch files will be re-encoded to OPUS on next sync/)
    ).toBeInTheDocument();
    expect(screen.getByText(/2 to sync/)).toBeInTheDocument();
  });
});
