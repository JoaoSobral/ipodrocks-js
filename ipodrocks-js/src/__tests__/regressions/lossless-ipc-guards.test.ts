/**
 * @vitest-environment node
 *
 * The lossless check's channels and Rocksy tools — the guards, not the
 * analysis (see `lossless-check-pipeline` for that):
 *
 * - **Owner-only over the web.** Starting, cancelling, overruling and above
 *   all *deleting* are refused to a non-owner web session, on the channel and
 *   on each Rocksy tool (whose gate must live inside `run()`, because
 *   `assistant:confirmAction` runs a client-supplied action). Reading the
 *   report is open to any allowlisted user, like every other library read.
 * - **One run at a time**, cancel reaches it, and the slot is released only by
 *   the run's own `finally`.
 * - **One Essentia job at a time.** The harmonic backfill and the lossless
 *   check share the analysis worker, and each terminates it to end a slow
 *   track — so neither may start while the other runs.
 * - **Delete waits** for a running check, which is still writing verdicts.
 *
 * The scan and delete are stubs whose runs last until aborted, so "is it still
 * running" has an exact answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const runs: Array<{ signal: AbortSignal; finish: () => void }> = [];
  const deletes: number[][] = [];
  return { handlers, runs, deletes };
});

vi.mock("../../main/host/bridge", () => ({
  handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    h.handlers.set(channel, fn);
  },
}));

vi.mock("../../main/ipc/common", () => ({
  safe:
    (_channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
    async (event: unknown, ...args: unknown[]) => {
      try {
        return await fn(event, ...args);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  getLibrary: () => ({
    getConnection: () => ({}),
    propagateScanToShadows: () => Promise.resolve(),
  }),
}));

vi.mock("../../main/ipc/library", () => ({
  isLibraryScanActive: () => false,
  reconcilePlaylistsAfterLibraryChange: vi.fn(),
}));

vi.mock("../../server/auth/sessions", () => ({
  denyIfNotOwner: (sessionId: string | undefined, message?: string) =>
    sessionId === undefined || sessionId === "owner" ? null : { error: message ?? "owner only" },
}));

vi.mock("../../main/activity/activity-logger", () => ({ logActivity: vi.fn() }));
vi.mock("../../main/assistant/assistantChat", () => ({ invalidateAssistantCache: vi.fn() }));
vi.mock("../../main/host", () => ({ getHostShell: () => ({ hasTrash: false }) }));

vi.mock("../../main/lossless/lossless-scan", () => ({
  runLosslessScan: (_db: unknown, _opts: unknown, _send: unknown, signal: AbortSignal) =>
    new Promise((resolve) => {
      const done = () => resolve({ checked: 0, deepChecked: 0, counts: {}, cancelled: signal.aborted });
      h.runs.push({ signal, finish: done });
      signal.addEventListener("abort", done, { once: true });
    }),
  getLosslessReport: () => [{ trackId: 7, verdict: "lossy_strong", override: false }],
  setLosslessOverride: (_db: unknown, ids: number[]) => ids.length,
  clearLosslessVerdicts: () => 0,
}));

vi.mock("../../main/lossless/lossless-delete", () => ({
  deleteFlaggedLosslessTracks: async (_db: unknown, ids: number[]) => {
    h.deletes.push(ids);
    return { deleted: ids.length, trashed: 0, permanent: ids.length, failed: [], removedTrackIds: ids, removedShadowPaths: [] };
  },
}));

import {
  registerLosslessHandlers,
  LOSSLESS_CHECK_RUNNING,
  OWNER_ONLY_LOSSLESS_DELETE_MESSAGE,
  OWNER_ONLY_LOSSLESS_MESSAGE,
} from "../../main/ipc/lossless";
import { claimEssentiaJob, essentiaJobInProgress, releaseEssentiaJob } from "../../main/harmonic/essentia-jobs";

registerLosslessHandlers();

function invoke(channel: string, sessionId: string | undefined, ...args: unknown[]) {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`${channel} not registered`);
  return fn({ sessionId, sender: { send: () => {}, isDestroyed: () => false } }, ...args);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  await invoke("lossless:cancel", undefined);
  await tick();
  h.runs.length = 0;
  h.deletes.length = 0;
});

describe("lossless:* channels", () => {
  it("runs one check at a time; cancel stops it and frees the slot", async () => {
    const first = invoke("lossless:scan", undefined, { scope: "all" });
    await tick();
    expect(h.runs).toHaveLength(1);
    expect(await invoke("lossless:status", undefined)).toMatchObject({ running: true });
    expect(await invoke("lossless:scan", undefined, { scope: "all" })).toEqual({ error: LOSSLESS_CHECK_RUNNING });
    expect(h.runs).toHaveLength(1);

    await invoke("lossless:cancel", undefined);
    expect(await first).toMatchObject({ cancelled: true });
    expect(await invoke("lossless:status", undefined)).toMatchObject({ running: false });
    expect(essentiaJobInProgress()).toBeNull();
  });

  it("refuses every mutation to a non-owner web session, but lets it read the report", async () => {
    expect(await invoke("lossless:scan", "guest", {})).toEqual({ error: OWNER_ONLY_LOSSLESS_MESSAGE });
    expect(await invoke("lossless:cancel", "guest")).toEqual({ error: OWNER_ONLY_LOSSLESS_MESSAGE });
    expect(await invoke("lossless:setOverride", "guest", { trackIds: [7], ok: true })).toEqual({
      error: OWNER_ONLY_LOSSLESS_MESSAGE,
    });
    expect(await invoke("lossless:clear", "guest")).toEqual({ error: OWNER_ONLY_LOSSLESS_MESSAGE });
    expect(await invoke("lossless:deleteFlagged", "guest", { trackIds: [7] })).toEqual({
      error: OWNER_ONLY_LOSSLESS_DELETE_MESSAGE,
    });
    expect(h.runs).toHaveLength(0);
    expect(h.deletes).toHaveLength(0);
    expect(await invoke("lossless:report", "guest")).toHaveLength(1);

    // Control: the owner's web session is admitted.
    expect(await invoke("lossless:deleteFlagged", "owner", { trackIds: [7] })).toMatchObject({ deleted: 1 });
  });

  it("passes only integer ids to the delete", async () => {
    await invoke("lossless:deleteFlagged", undefined, { trackIds: [7, "../../etc/passwd", 1.5, -3, 9] });
    expect(h.deletes).toEqual([[7, 9]]);
  });

  it("refuses to delete while a check is running", async () => {
    const run = invoke("lossless:scan", undefined, {});
    await tick();
    expect(await invoke("lossless:deleteFlagged", undefined, { trackIds: [7] })).toMatchObject({
      error: expect.stringMatching(/lossless check/i),
    });
    expect(h.deletes).toHaveLength(0);
    await invoke("lossless:cancel", undefined);
    await run;
  });

  it("will not start while the harmonic analysis holds the Essentia worker", async () => {
    expect(claimEssentiaJob("harmonic analysis")).toBeNull();
    try {
      expect(await invoke("lossless:scan", undefined, {})).toMatchObject({
        error: expect.stringMatching(/harmonic analysis/),
      });
      expect(h.runs).toHaveLength(0);
    } finally {
      releaseEssentiaJob("harmonic analysis");
    }
    // And the other way round: a running check holds it.
    const run = invoke("lossless:scan", undefined, {});
    await tick();
    expect(claimEssentiaJob("harmonic analysis")).toBe("lossless check");
    await invoke("lossless:cancel", undefined);
    await run;
    expect(claimEssentiaJob("harmonic analysis")).toBeNull();
    releaseEssentiaJob("harmonic analysis");
  });
});

describe("Rocksy lossless tools re-apply the owner gate inside run()", () => {
  it("refuses a non-owner session on every mutating tool, and admits the desktop", async () => {
    const { getToolByName } = await import("../../main/assistant/tools");
    const guest = { db: {}, sessionId: "guest", sender: { send: vi.fn(), isDestroyed: () => false } } as never;
    for (const [name, args] of [
      ["lossless_check", { scope: "all" }],
      ["lossless_mark_ok", { trackIds: [7] }],
      ["lossless_delete_flagged", { trackIds: [7] }],
    ] as const) {
      const tool = getToolByName(name)!;
      expect(tool, name).toBeDefined();
      const out = (await tool.run(args as never, guest)) as { error?: string };
      expect(out.error, name).toMatch(/owner/i);
    }
    expect(h.deletes).toHaveLength(0);

    const sender = { send: vi.fn(), isDestroyed: () => false };
    const desktop = { db: {}, sessionId: undefined, sender } as never;
    const del = (await getToolByName("lossless_delete_flagged")!.run({ trackIds: [7] } as never, desktop)) as {
      ok: boolean;
    };
    expect(del.ok).toBe(true);
    expect(h.deletes).toEqual([[7]]);

    await getToolByName("lossless_check")!.run({ scope: "all" } as never, desktop);
    expect(sender.send).toHaveBeenCalledWith("assistant:triggerLosslessCheck", { scope: "all", deep: true });
  });

  it("classifies the tools in the right tiers", async () => {
    const { getToolByName } = await import("../../main/assistant/tools");
    expect(getToolByName("lossless_check")!.kind).toBe("write-destructive");
    expect(getToolByName("lossless_delete_flagged")!.kind).toBe("write-destructive");
    expect(getToolByName("lossless_mark_ok")!.kind).toBe("write-safe");
    expect(getToolByName("lossless_report")!.kind).toBe("read");
  });
});
