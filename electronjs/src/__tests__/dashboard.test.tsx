import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardPanel } from "../renderer/components/panels/DashboardPanel";

vi.mock("../renderer/ipc/api", () => ({
  getShadowLibraries: vi.fn().mockResolvedValue([]),
  getLibraryStats: vi.fn().mockResolvedValue({
    totalTracks: 0,
    totalAlbums: 0,
    totalArtists: 0,
    totalSizeBytes: 0,
  }),
  getDevices: vi.fn().mockResolvedValue([]),
  getRecentActivity: vi.fn().mockResolvedValue([]),
}));

describe("DashboardPanel", () => {
  it("renders Library section", () => {
    render(<DashboardPanel />);
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Collection overview")).toBeInTheDocument();
  });

  it("renders Devices section", () => {
    render(<DashboardPanel />);
    expect(screen.getByText("Devices")).toBeInTheDocument();
  });

  it("renders Shadow Libraries section", () => {
    render(<DashboardPanel />);
    expect(screen.getByText("Shadow Libraries")).toBeInTheDocument();
  });

  it("renders Recent Activity section", () => {
    render(<DashboardPanel />);
    expect(screen.getByText("Recent Activity")).toBeInTheDocument();
    expect(screen.getByText("Last 100 operations")).toBeInTheDocument();
  });
});
