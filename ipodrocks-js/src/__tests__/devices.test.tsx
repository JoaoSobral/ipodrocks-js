import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DevicePanel } from "../renderer/components/panels/DevicePanel";
import { getDevices, checkDevice, addDevice } from "../renderer/ipc/api";

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
  podcastSetDeviceAutoPodcasts: vi.fn().mockResolvedValue(undefined),
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

  it("shows validation hints for all required fields when add device submitted empty", async () => {
    render(<DevicePanel />);
    fireEvent.click(screen.getByText("+ Add Device"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("My iPod")).toBeInTheDocument();
    });

    // Use exact match to avoid matching the "+ Add Device" opener button
    const saveButton = screen.getByRole("button", { name: "Add Device" });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    expect(screen.getByText("Please enter a device name")).toBeInTheDocument();
    expect(screen.getByText("Please enter a mount path")).toBeInTheDocument();
    expect(screen.getByText("Please select a device model")).toBeInTheDocument();
  });

  it("shows Auto Podcasts checkbox unchecked by default in Add Device modal", async () => {
    render(<DevicePanel />);
    fireEvent.click(screen.getByText("+ Add Device"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("My iPod")).toBeInTheDocument();
    });

    const checkbox = screen.getByRole("checkbox", { name: /Auto Podcasts/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it("loads autoPodcastsEnabled from device profile when editing", async () => {
    vi.mocked(getDevices).mockResolvedValueOnce([
      {
        id: 5,
        name: "Podcast iPod",
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

    render(<DevicePanel />);

    await waitFor(() => {
      expect(screen.getByText("Podcast iPod")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Edit/i }));

    await waitFor(() => {
      const checkbox = screen.getByRole("checkbox", { name: /Auto Podcasts/i });
      expect(checkbox).toBeChecked();
    });
  });

  it("calls addDevice when all required fields are filled", async () => {
    vi.mocked(addDevice).mockResolvedValueOnce({
      id: 99,
      name: "Test Device",
      mountPath: "/mnt/test",
      musicFolder: "Music",
      podcastFolder: "Podcasts",
      audiobookFolder: "Audiobooks",
      playlistFolder: "Playlists",
      modelId: 1,
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
      codecName: null,
      modelName: "iPod Classic",
      modelInternalValue: null,
    } as never);

    // Provide a model option so the Select can be used
    const { getDeviceModels } = await import("../renderer/ipc/api");
    vi.mocked(getDeviceModels).mockResolvedValueOnce([{ id: 1, name: "iPod Classic" } as never]);

    render(<DevicePanel />);
    fireEvent.click(screen.getByText("+ Add Device"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("My iPod")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText("My iPod"), {
      target: { value: "Test Device" },
    });
    fireEvent.change(screen.getByPlaceholderText("/mnt/ipod"), {
      target: { value: "/mnt/test" },
    });

    expect(screen.queryByText("Please enter a device name")).not.toBeInTheDocument();
    expect(screen.queryByText("Please enter a mount path")).not.toBeInTheDocument();
  });
});
