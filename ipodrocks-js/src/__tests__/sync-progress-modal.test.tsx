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

  it("does not claim 'nothing to sync' when the reply beat its own progress frames", async () => {
    // The regression. Progress frames travel `webContents.send`; the result
    // comes back on the `invoke` reply, and Electron orders neither against the
    // other. A sync of a handful of files routinely resolves before a single
    // `copy` frame has been dispatched — and the modal used to unsubscribe in
    // `.finally()`, so the frames that followed were dropped on the floor and it
    // rendered "Nothing to sync — device up to date." over a sync that had just
    // copied the user's whole selection.
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    await finishSync({ synced: 3, errors: 0 });

    await waitFor(() => expect(screen.getByText("Synced 3 items.")).toBeInTheDocument());
    expect(
      screen.queryByText("Nothing to sync — device up to date."),
    ).not.toBeInTheDocument();
    // The result's own count carries the summary when no frames arrived.
    expect(screen.getByText("Processed")).toBeInTheDocument();
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("keeps listening after the reply, so late frames still fill the list", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    await finishSync({ synced: 2, errors: 0 });
    // ...and only now do this sync's own frames turn up.
    emit({ event: "total", path: "2" });
    emit({ event: "copy", path: "late1.mp3", status: "copied", contentType: "music" });
    emit({ event: "copy", path: "late2.mp3", status: "copied", contentType: "music" });

    await waitFor(() => expect(screen.getByText("late1.mp3")).toBeInTheDocument());
    expect(screen.getByText("late2.mp3")).toBeInTheDocument();
  });

  it("still says 'nothing to sync' when the device really was up to date", async () => {
    // The guard above must not swallow the genuine no-op, which is the whole
    // reason that message exists.
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);

    emit({ event: "total", path: "5" });
    emit({ status: "complete" });
    await finishSync({ synced: 0, errors: 0 });

    await waitFor(() =>
      expect(screen.getByText("Nothing to sync — device up to date.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Processed")).not.toBeInTheDocument();
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

// A remote sync over a few MB/s used to look hung: four large files share
// the link, nothing *finishes* for a minute, and the modal only ever showed
// finished files and a count-based percentage — "0 / 2921 copied, 0%" with
// "Preparing files for sync…" over a sync that was moving data the whole
// time, and every phase message it sent was kept in a list nobody rendered.
describe("progress before the first file lands", () => {
  it("renders what the sync says, not just the files", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({ event: "log", message: "Comparing library with device (music)..." });
    emit({ event: "log", message: "Found 3 track(s) to sync, 0 already on device." });

    // In the Progress box — the status line also shows the newest one.
    await waitFor(() => expect(screen.getAllByTestId("sync-feed-log")).toHaveLength(2));
    const lines = screen.getAllByTestId("sync-feed-log").map((el) => el.textContent);
    expect(lines).toEqual([
      "Comparing library with device (music)...",
      "Found 3 track(s) to sync, 0 already on device.",
    ]);
    expect(screen.queryByText("Waiting for sync…")).not.toBeInTheDocument();
  });

  it("lists files in flight with their bytes, and drops them when they land", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({ event: "total", path: "2" });
    emit({ event: "copy_start", path: "/lib/A/01 Big.flac", bytes: 30 * 1024 * 1024 });
    emit({ event: "copy_start", path: "/lib/A/02 Bigger.flac", bytes: 40 * 1024 * 1024 });
    emit({
      event: "bytes",
      bytes: 12 * 1024 * 1024,
      inflight: [
        { path: "/lib/A/01 Big.flac", done: 12 * 1024 * 1024, total: 30 * 1024 * 1024 },
        { path: "/lib/A/02 Bigger.flac", done: 0, total: 40 * 1024 * 1024 },
      ],
    });

    await waitFor(() => expect(screen.getAllByTestId("sync-inflight-file")).toHaveLength(2));
    expect(screen.getByText(/01 Big\.flac/)).toBeInTheDocument();
    expect(screen.getByText("12 MB / 30 MB")).toBeInTheDocument();

    emit({ event: "copy", path: "/lib/A/01 Big.flac", status: "copied", contentType: "music" });
    await waitFor(() => expect(screen.getAllByTestId("sync-inflight-file")).toHaveLength(1));
  });

  it("moves the bar with the bytes while nothing has finished", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({ event: "total", path: "4" });
    emit({ event: "total_bytes", bytes: 100 * 1024 * 1024 });
    emit({ event: "bytes", bytes: 25 * 1024 * 1024, inflight: [] });

    await waitFor(() => expect(screen.getByText("25%")).toBeInTheDocument());
    // ...and no file has been counted as copied.
    expect(screen.getByText("0 / 4 copied")).toBeInTheDocument();
  });

  it("falls back to the count when the byte total is unknown (transcodes)", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({ event: "total", path: "4" });
    emit({ event: "bytes", bytes: 25 * 1024 * 1024 });
    emit({ event: "copy", path: "a.mpc", status: "converted", contentType: "music" });

    await waitFor(() => expect(screen.getByText("25%")).toBeInTheDocument());
  });
});

// An iPod that dropped off USB mid-sync used to end with a red box naming an
// album folder — "/media/music/Parcels/Parcels" — because any event with
// status "error" was written into the sync-level error.
describe("a device that disconnects mid-sync", () => {
  it("does not put one file's failure in the sync's error box", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({ event: "total", path: "2" });
    emit({ event: "copy", path: "/media/music/Parcels/Parcels", status: "error", contentType: "artwork" });

    await waitFor(() => expect(screen.getByText("1 processed")).toBeInTheDocument());
    // Once, as the ✕ line. Before the fix the error box repeated it.
    expect(screen.getAllByText("/media/music/Parcels/Parcels")).toHaveLength(1);
  });

  it("says the device disconnected while it waits", async () => {
    render(<SyncProgressModal open onClose={() => {}} syncOptions={SYNC_OPTIONS} />);
    emit({
      event: "state",
      state: "waiting",
      waitKind: "unplugged",
      message: "The device disconnected. Plug it back in — the sync continues from the file it was on.",
    });
    await waitFor(() => expect(screen.getByTestId("sync-waiting")).toBeInTheDocument());
    expect(screen.getByTestId("sync-waiting")).toHaveTextContent("Plug it back in");

    emit({ event: "state", state: "running", message: "Device reconnected — resuming." });
    await waitFor(() => expect(screen.queryByTestId("sync-waiting")).not.toBeInTheDocument());
  });
});
