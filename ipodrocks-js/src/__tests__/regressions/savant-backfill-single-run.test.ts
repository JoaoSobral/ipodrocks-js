/**
 * @vitest-environment node
 *
 * Regression — `savant:backfillFeatures` kept one bare `AbortController` in a
 * module global and overwrote it on every call.
 *
 * So a second call orphaned the first run (nothing could cancel it any more),
 * the first run to finish nulled the slot out from under the newest, and any
 * allowlisted web user could start as many library-wide analyses as they
 * liked. Pinned here: one run at a time server-wide, cancel reaches it, a
 * finishing run clears only its own slot, and both channels refuse a
 * non-owner web session — for the Essentia path and the tag path alike, since
 * they share the handler.
 *
 * The scanner is a stub whose runs last until aborted, so "is it still
 * running" is a question with an exact answer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  const runs: Array<{ kind: "essentia" | "tags"; signal: AbortSignal; finish: (n: number) => void }> = [];
  const prefs = { analyzeWithEssentia: true, analyzePercent: 10, backfillPercent: 100 };
  return { handlers, runs, prefs };
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
    getConnection: () => ({ prepare: () => ({ get: () => ({ c: 100 }) }) }),
  }),
  getPlaylistCore: () => ({}),
}));

vi.mock("../../main/library/library-scanner", () => {
  function run(kind: "essentia" | "tags", signal: AbortSignal): Promise<number> {
    return new Promise((resolve) => {
      h.runs.push({ kind, signal, finish: resolve });
      signal.addEventListener("abort", () => resolve(0), { once: true });
    });
  }
  return {
    LibraryScanner: class {
      backfillFeaturesWithEssentia(_percent: number, _cb: unknown, signal: AbortSignal) {
        return run("essentia", signal);
      }
      backfillFeatures(_max: number, _cb: unknown, signal: AbortSignal) {
        return run("tags", signal);
      }
    },
  };
});

vi.mock("../../main/utils/prefs", () => ({
  getHarmonicPrefs: () => h.prefs,
  getOpenRouterConfig: () => null,
}));

vi.mock("../../server/auth/sessions", () => ({
  // "owner" and the desktop window (no session) are admitted; anyone else is not.
  denyIfNotOwner: (sessionId: string | undefined, message: string) =>
    sessionId === undefined || sessionId === "owner" ? null : { error: message },
}));

vi.mock("../../main/llm/openRouterClient", () => ({ checkRateLimit: () => true }));
vi.mock("../../main/savant/savantEngine", () => ({ generateSavantPlaylist: vi.fn() }));
vi.mock("../../main/savant/moodChat", () => ({ startMoodChat: vi.fn(), processMoodChatTurn: vi.fn() }));
vi.mock("../../main/savant/savantPlaylistChat", () => ({
  startSavantPlaylistChat: vi.fn(),
  processSavantPlaylistChatTurn: vi.fn(),
}));
vi.mock("../../main/activity/activity-logger", () => ({ logActivity: vi.fn() }));

import {
  registerSavantHandlers,
  BACKFILL_ALREADY_RUNNING,
  OWNER_ONLY_BACKFILL_MESSAGE,
} from "../../main/ipc/savant";

registerSavantHandlers();

function invoke(channel: string, sessionId: string | undefined, ...args: unknown[]) {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`${channel} not registered`);
  return fn({ sessionId, sender: { send: () => {} } }, ...args);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function cancelAndDrain(): Promise<void> {
  await invoke("savant:backfillCancel", undefined);
  await tick();
}

describe.each([
  ["Essentia", true, "essentia"],
  ["tag", false, "tags"],
] as const)("savant:backfillFeatures — %s path", (_label, essentia, kind) => {
  beforeEach(async () => {
    h.prefs.analyzeWithEssentia = essentia;
    await cancelAndDrain();
    h.runs.length = 0;
  });

  it("refuses a second run while one is active, and cancel stops the active one", async () => {
    const first = invoke("savant:backfillFeatures", undefined, { percent: 100 });
    await tick();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0].kind).toBe(kind);

    expect(await invoke("savant:backfillFeatures", undefined, { percent: 100 })).toEqual({
      error: BACKFILL_ALREADY_RUNNING,
    });
    expect(h.runs).toHaveLength(1);

    await invoke("savant:backfillCancel", undefined);
    expect(h.runs[0].signal.aborted).toBe(true);
    expect(await first).toEqual({ processed: 0, cancelled: true });

    // The slot is free again once the run has actually ended.
    const next = invoke("savant:backfillFeatures", undefined, {});
    await tick();
    expect(h.runs).toHaveLength(2);
    h.runs[1].finish(3);
    expect(await next).toEqual({ processed: 3, cancelled: false });
  });

  it("does not admit a second run while the cancelled one is still winding down", async () => {
    const first = invoke("savant:backfillFeatures", undefined, {});
    await tick();
    // Abort without letting the stub resolve yet: the run is still in its
    // in-flight track.
    const run = h.runs[0];
    const pendingCancel = invoke("savant:backfillCancel", undefined);
    expect(await invoke("savant:backfillFeatures", "owner", {})).toEqual({
      error: BACKFILL_ALREADY_RUNNING,
    });
    await pendingCancel;
    expect(run.signal.aborted).toBe(true);
    await first;
  });

  it("a non-owner web session can neither start nor cancel a run", async () => {
    expect(await invoke("savant:backfillFeatures", "guest", { percent: 100 })).toEqual({
      error: OWNER_ONLY_BACKFILL_MESSAGE,
    });
    expect(h.runs).toHaveLength(0);

    const ownerRun = invoke("savant:backfillFeatures", "owner", {});
    await tick();
    expect(h.runs).toHaveLength(1);
    expect(await invoke("savant:backfillCancel", "guest")).toEqual({
      error: OWNER_ONLY_BACKFILL_MESSAGE,
    });
    expect(h.runs[0].signal.aborted).toBe(false);

    // Control: the owner's own cancel works.
    await invoke("savant:backfillCancel", "owner");
    expect(h.runs[0].signal.aborted).toBe(true);
    await ownerRun;
  });
});
