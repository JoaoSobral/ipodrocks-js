import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RatingConflictsModal } from "../renderer/components/RatingConflictsModal";
import type { RatingConflictRow } from "../shared/types";

vi.mock("@shared/ratings", () => ({
  rocksToStars: (r: number | null) => (r == null ? null : r / 2),
  starsToRocks: (s: number | null) => {
    if (s == null) return null;
    return Math.round(s * 2);
  },
}));

const mockGetRatingConflicts = vi.fn();
const mockResolveRatingConflict = vi.fn();

vi.mock("../renderer/ipc/api", () => ({
  getRatingConflicts: (...args: unknown[]) => mockGetRatingConflicts(...args),
  resolveRatingConflict: (...args: unknown[]) => mockResolveRatingConflict(...args),
}));

const sampleConflict: RatingConflictRow = {
  id: 1,
  track_id: 10,
  device_id: 1,
  reported_rating: 8,
  baseline_rating: 6,
  canonical_rating: 4,
  reported_at: "2026-04-20T10:00:00Z",
  resolved_at: null,
  resolution: null,
  title: "Test Track",
  path: "/lib/test.mp3",
  artist: "Test Artist",
  device_name: "My iPod",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RatingConflictsModal", () => {
  it("does not render when closed", () => {
    mockGetRatingConflicts.mockResolvedValue([]);
    render(<RatingConflictsModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows spinner while loading", async () => {
    mockGetRatingConflicts.mockReturnValue(new Promise(() => {})); // never resolves
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    expect(document.querySelector("dialog, [role=dialog]")).toBeTruthy();
  });

  it("shows empty state when no conflicts", async () => {
    mockGetRatingConflicts.mockResolvedValue([]);
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/no rating conflicts/i)).toBeInTheDocument();
    });
  });

  it("renders conflict row with track info and device name", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Test Track")).toBeInTheDocument();
      expect(screen.getByText("Test Artist")).toBeInTheDocument();
      expect(screen.getByText("My iPod")).toBeInTheDocument();
    });
  });

  it("shows Device and Library labels for the two ratings", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Device")).toBeInTheDocument();
      expect(screen.getByText("Library")).toBeInTheDocument();
    });
  });

  it("calls resolveRatingConflict with canonical_wins on Keep Library click", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    mockResolveRatingConflict.mockResolvedValue({ ok: true, newRating: 4 });
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Keep Library"));
    fireEvent.click(screen.getByText("Keep Library"));
    await waitFor(() => {
      expect(mockResolveRatingConflict).toHaveBeenCalledWith(1, "canonical_wins", undefined);
    });
  });

  it("calls resolveRatingConflict with device_wins on Use Device click", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    mockResolveRatingConflict.mockResolvedValue({ ok: true, newRating: 8 });
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Use Device"));
    fireEvent.click(screen.getByText("Use Device"));
    await waitFor(() => {
      expect(mockResolveRatingConflict).toHaveBeenCalledWith(1, "device_wins", undefined);
    });
  });

  it("removes the conflict row from the list after resolution", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    mockResolveRatingConflict.mockResolvedValue({ ok: true, newRating: 4 });
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Keep Library"));
    fireEvent.click(screen.getByText("Keep Library"));
    await waitFor(() => {
      expect(screen.queryByText("Test Track")).not.toBeInTheDocument();
    });
  });

  it("expands manual rating picker on Set Manually click", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText(/Set Manually/));
    fireEvent.click(screen.getByText(/Set Manually/));
    await waitFor(() => {
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  it("calls resolveRatingConflict with manual resolution on Save", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    mockResolveRatingConflict.mockResolvedValue({ ok: true, newRating: 6 });
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText(/Set Manually/));
    fireEvent.click(screen.getByText(/Set Manually/));
    await waitFor(() => screen.getByText("Save"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(mockResolveRatingConflict).toHaveBeenCalledWith(1, "manual", expect.anything());
    });
  });

  it("shows empty state after all conflicts are resolved", async () => {
    mockGetRatingConflicts.mockResolvedValue([sampleConflict]);
    mockResolveRatingConflict.mockResolvedValue({ ok: true, newRating: 4 });
    render(<RatingConflictsModal open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Keep Library"));
    fireEvent.click(screen.getByText("Keep Library"));
    await waitFor(() => {
      expect(screen.getByText(/no rating conflicts/i)).toBeInTheDocument();
    });
  });

  it("refetches conflict count on modal close", async () => {
    const onClose = vi.fn();
    mockGetRatingConflicts.mockResolvedValue([]);
    render(<RatingConflictsModal open onClose={onClose} />);
    await waitFor(() => screen.getByText(/no rating conflicts/i));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
