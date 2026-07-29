/**
 * @vitest-environment jsdom
 *
 * Component tests for SyncProgressModal's completion messaging.
 *
 * Covers the distinction between:
 *  - "Nothing to sync — device up to date." when no items were processed
 *  - the statistics summary card when items were actually synced
 *  - "Sync was cancelled." when the user cancels with nothing processed
 *
 * The renderer IPC module is mocked so we can drive sync:progress events and
 * resolve startSync() without a real device.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import type { SyncOptions, SyncProgress } from "@shared/types";

// ---- Mock the renderer IPC api ----

let progressCb: ((p: SyncProgress) => void) | null = null;
type StartSyncResult = {
  synced?: number;
  errors?: number;
  artworkErrors?: number;
  error?: string;
};
let resolveStartSync: ((r: StartSyncResult) => void) | null = null;
const startSyncMock = vi.fn(
  (_opts?: SyncOptions) =>
    new Promise<StartSyncResult>((resolve) => {
      resolveStartSync = resolve;
    }),
);
const cancelSyncMock = vi.fn(async () => {});

vi.mock("@renderer/ipc/api", () => ({
  startSync: (opts: SyncOptions) => startSyncMock(opts),
  cancelSync: () => cancelSyncMock(),
  onSyncProgress: (cb: (p: SyncProgress) => void) => {
    progressCb = cb;
    return () => {
      progressCb = null;
    };
  },
}));

import { SyncProgressModal } from "@renderer/components/modals/SyncProgressModal";

const SYNC_OPTIONS = {} as SyncOptions;

function emit(p: Record<string, unknown>) {
  act(() => {
    progressCb?.(p as unknown as SyncProgress);
  });
}

async function finishSync(result: StartSyncResult) {
  await act(async () => {
    resolveStartSync?.(result);
    await Promise.resolve();
  });
}

describe("SyncProgressModal completion messaging", () => {
  beforeEach(() => {
    progressCb = null;
    resolveStartSync = null;
    startSyncMock.mockClear();
    cancelSyncMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 'Nothing to sync — device up to date.' when no items were processed", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    // Backend reports a total but every item is already up to date (no copy events).
    emit({ event: "total", path: "5" });
    emit({ status: "complete" });
    await finishSync({ synced: 0, errors: 0 });

    await waitFor(() =>
      expect(screen.getByText("Nothing to sync — device up to date.")).toBeInTheDocument(),
    );
    // No "Sync completed." and no statistics card.
    expect(screen.queryByText("Sync completed.")).not.toBeInTheDocument();
    expect(screen.queryByText("Processed")).not.toBeInTheDocument();
  });

  it("shows the statistics card when items were actually synced", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    emit({ event: "total", path: "2" });
    emit({ event: "copy", path: "song1.mp3", status: "copied", contentType: "music" });
    emit({ event: "copy", path: "song2.mp3", status: "skipped", contentType: "music" });
    emit({ status: "complete" });
    await finishSync({ synced: 1, errors: 0 });

    await waitFor(() => expect(screen.getByText("Processed")).toBeInTheDocument());
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    // The "nothing to sync" placeholder must not appear when work happened.
    expect(screen.queryByText("Nothing to sync — device up to date.")).not.toBeInTheDocument();
  });

  it("shows the progress bar at 100% on a clean finish even if total was over-counted", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    // Backend pre-counts 11 but only 6 items ever produce a copy event.
    emit({ event: "total", path: "11" });
    for (let i = 1; i <= 6; i++) {
      emit({ event: "copy", path: `song${i}.opus`, status: "copied", contentType: "music" });
    }
    emit({ status: "complete" });
    await finishSync({ synced: 6, errors: 0 });

    // The bar must read 100%, not 55% (6/11).
    await waitFor(() => expect(screen.getByText("100%")).toBeInTheDocument());
    expect(screen.queryByText("55%")).not.toBeInTheDocument();
  });

  it("shows a live copied/total counter while syncing", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    emit({ event: "total", path: "6" });
    emit({ event: "copy", path: "song1.opus", status: "copied", contentType: "music" });
    emit({ event: "copy", path: "song2.opus", status: "copied", contentType: "music" });

    // Mid-sync, the top-right shows copied / total (e.g. "2 / 6 copied").
    await waitFor(() => expect(screen.getByText("2 / 6 copied")).toBeInTheDocument());
  });

  it("shows 'Sync was cancelled.' when cancelled with nothing processed", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    emit({ event: "total", path: "5" });
    emit({ status: "cancelled" });
    await finishSync({ error: "Sync cancelled" });

    await waitFor(() => expect(screen.getByText("Sync was cancelled.")).toBeInTheDocument());
    expect(screen.queryByText("Nothing to sync — device up to date.")).not.toBeInTheDocument();
    expect(screen.queryByText("Processed")).not.toBeInTheDocument();
  });
});

describe("SyncProgressModal album-artwork failures", () => {
  beforeEach(() => {
    progressCb = null;
    resolveStartSync = null;
    startSyncMock.mockClear();
    cancelSyncMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive one processed item so the summary card renders. */
  function emitOneCopiedTrack() {
    emit({ event: "total", path: "1" });
    emit({ event: "copy", path: "/music/song.mp3", status: "copied", contentType: "music" });
  }

  it("names album artwork explicitly and clears song data of blame", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emitOneCopiedTrack();
    await finishSync({ synced: 1, errors: 0, artworkErrors: 2 });

    await waitFor(() => {
      expect(screen.getByText(/Album artwork failed for 2 albums/i)).toBeTruthy();
    });
    // The wording must not let the user think tracks were lost.
    expect(screen.getByText(/song files copied successfully/i)).toBeTruthy();
  });

  it("uses the singular form for a single failed album", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emitOneCopiedTrack();
    await finishSync({ synced: 1, errors: 0, artworkErrors: 1 });

    await waitFor(() => {
      expect(screen.getByText(/Album artwork failed for 1 album\b/i)).toBeTruthy();
    });
  });

  it("reports a failure status when only artwork failed", async () => {
    const onComplete = vi.fn();
    render(
      <SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} onComplete={onComplete} />
    );
    emitOneCopiedTrack();
    await finishSync({ synced: 1, errors: 0, artworkErrors: 3 });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      status: "error",
      errors: 0,
      artworkErrors: 3,
    });
  });

  it("keeps artwork failures out of the song-error count", async () => {
    const onComplete = vi.fn();
    render(
      <SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} onComplete={onComplete} />
    );
    emitOneCopiedTrack();
    await finishSync({ synced: 4, errors: 2, artworkErrors: 5 });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const result = onComplete.mock.calls[0][0];
    expect(result.errors).toBe(2);
    expect(result.artworkErrors).toBe(5);
  });

  it("says nothing about artwork when none failed", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emitOneCopiedTrack();
    await finishSync({ synced: 1, errors: 0, artworkErrors: 0 });

    await waitFor(() => expect(screen.queryByText(/Album artwork failed/i)).toBeNull());
  });

  it("does not blame artwork when the sync was cancelled", async () => {
    const onComplete = vi.fn();
    render(
      <SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} onComplete={onComplete} />
    );
    emitOneCopiedTrack();
    await finishSync({ synced: 1, artworkErrors: 4, error: "Sync cancelled by user." });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0][0]).toMatchObject({ status: "warning", artworkErrors: 0 });
    expect(screen.queryByText(/Album artwork failed/i)).toBeNull();
  });
});
