import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { BackfillProgressModal } from "../renderer/components/modals/BackfillProgressModal";
import type { BackfillProgress } from "../shared/types";

// --- IPC mock ---------------------------------------------------------------

type ProgressCb = (p: BackfillProgress) => void;

let resolveBackfill: (v: { processed: number; cancelled?: boolean }) => void =
  () => {};
let progressListeners: ProgressCb[] = [];

vi.mock("../renderer/ipc/api", () => ({
  backfillSavantFeatures: vi.fn(
    () =>
      new Promise<{ processed: number; cancelled?: boolean }>((res) => {
        resolveBackfill = res;
      })
  ),
  cancelBackfill: vi.fn(),
  onBackfillProgress: vi.fn((cb: ProgressCb) => {
    progressListeners.push(cb);
    return () => {
      progressListeners = progressListeners.filter((l) => l !== cb);
    };
  }),
}));

function emitProgress(p: BackfillProgress) {
  for (const l of progressListeners) l(p);
}

// --- helpers ----------------------------------------------------------------

function renderModal(
  open = true,
  onClose = vi.fn(),
  onComplete = vi.fn()
) {
  return render(
    <BackfillProgressModal
      open={open}
      onClose={onClose}
      onComplete={onComplete}
    />
  );
}

beforeEach(() => {
  progressListeners = [];
  vi.clearAllMocks();
});

// --- tests ------------------------------------------------------------------

describe("BackfillProgressModal — stays open after completion", () => {
  it("does NOT call onClose automatically when backfill finishes", async () => {
    const onClose = vi.fn();
    renderModal(true, onClose);

    await act(async () => {
      resolveBackfill({ processed: 3 });
    });

    // onClose must NOT have been called yet — user needs to press Done
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows Done button (not Cancel) after completion", async () => {
    renderModal();

    await act(async () => {
      resolveBackfill({ processed: 5 });
    });

    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cancel/i })
    ).not.toBeInTheDocument();
  });

  it("calls onClose when user presses Done", async () => {
    const onClose = vi.fn();
    renderModal(true, onClose);

    await act(async () => {
      resolveBackfill({ processed: 3 });
    });

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("BackfillProgressModal — Essentia hint", () => {
  it("shows Essentia hint when backfill finishes with 0 keys found", async () => {
    renderModal();

    await act(async () => {
      // Emit progress events with success:false so processedCount stays 0
      emitProgress({
        path: "/music/a.mp3",
        processed: 1,
        total: 2,
        success: false,
        status: "analyzing",
      });
      emitProgress({
        path: "/music/b.mp3",
        processed: 2,
        total: 2,
        success: false,
        status: "complete",
      });
      resolveBackfill({ processed: 2 });
    });

    await waitFor(() =>
      expect(screen.getByText(/essentia\.js analysis/i)).toBeInTheDocument()
    );
  });

  it("does NOT show Essentia hint when keys were found", async () => {
    renderModal();

    await act(async () => {
      // "analyzing" carries the success flag; "complete" triggers finished state
      emitProgress({
        path: "/music/a.mp3",
        processed: 1,
        total: 1,
        success: true,
        status: "analyzing",
      });
      emitProgress({
        path: "/music/a.mp3",
        processed: 1,
        total: 1,
        success: true,
        status: "complete",
      });
      resolveBackfill({ processed: 1 });
    });

    // Give React time to flush state updates
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/essentia\.js analysis/i)
    ).not.toBeInTheDocument();
  });

  it("does NOT show Essentia hint when backfill was cancelled", async () => {
    renderModal();

    await act(async () => {
      resolveBackfill({ processed: 0, cancelled: true });
    });

    expect(
      screen.queryByText(/essentia\.js analysis/i)
    ).not.toBeInTheDocument();
  });
});

describe("BackfillProgressModal — empty state message", () => {
  it("shows 'No tracks were found to process' when backfill completes with nothing to do", async () => {
    renderModal();

    await act(async () => {
      resolveBackfill({ processed: 0 });
    });

    await waitFor(() =>
      expect(
        screen.getByText(/no tracks were found to process/i)
      ).toBeInTheDocument()
    );
  });

  it("shows 'Waiting for backfill…' before the process starts", () => {
    renderModal();
    expect(screen.getByText(/waiting for backfill/i)).toBeInTheDocument();
  });
});

describe("BackfillProgressModal — progress tracking", () => {
  it("shows processed / total counts during analysis", async () => {
    renderModal();

    act(() => {
      emitProgress({
        path: "/music/a.mp3",
        processed: 1,
        total: 5,
        success: true,
        status: "analyzing",
      });
    });

    await waitFor(() =>
      expect(screen.getByText(/1 \/ 5/)).toBeInTheDocument()
    );
  });

  it("shows summary stats after completion", async () => {
    renderModal();

    await act(async () => {
      emitProgress({
        path: "/music/a.mp3",
        processed: 3,
        total: 3,
        success: true,
        status: "complete",
      });
      resolveBackfill({ processed: 3 });
    });

    await waitFor(() =>
      expect(screen.getByText("3")).toBeInTheDocument()
    );
  });
});
