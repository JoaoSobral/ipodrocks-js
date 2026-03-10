import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SyncPanel } from "../renderer/components/panels/SyncPanel";

vi.mock("../renderer/ipc/api", () => ({
  getDevices: vi.fn().mockResolvedValue([]),
  getTracks: vi.fn().mockResolvedValue([]),
  getPlaylists: vi.fn().mockResolvedValue([]),
  getPlaylistTracks: vi.fn().mockResolvedValue([]),
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  getLibraryStats: vi.fn().mockResolvedValue({ totalTracks: 0 }),
}));

describe("SyncPanel", () => {
  it("renders sync panel", () => {
    render(<SyncPanel />);
    expect(screen.getByText("Target Device")).toBeInTheDocument();
    expect(screen.getByText("Sync Configuration")).toBeInTheDocument();
  });
});
