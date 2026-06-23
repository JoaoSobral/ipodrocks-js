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
let resolveStartSync: ((r: { synced?: number; errors?: number; error?: string }) => void) | null = null;
const startSyncMock = vi.fn(
  (_opts?: SyncOptions) =>
    new Promise<{ synced?: number; errors?: number; error?: string }>((resolve) => {
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

async function finishSync(result: { synced?: number; errors?: number; error?: string }) {
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
