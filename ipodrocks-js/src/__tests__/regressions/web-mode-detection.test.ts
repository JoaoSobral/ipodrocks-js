/**
 * @vitest-environment jsdom
 *
 * Regression — `isWebMode()` has to keep being true after bootstrap.
 *
 * It was written as "there is no preload", i.e. `window.api === undefined`.
 * That is a correct *bootstrap* question and `main.tsx` still asks it that way,
 * before anything is installed. But `installWebTransport()` **installs
 * `window.api`** — so from the moment the transport is up, the absence test is
 * false in Electron and false in a browser alike, and every other caller runs
 * after that point.
 *
 * The result was a browser UI quietly convinced it was Electron:
 *
 *  - the Devices panel labelled its button "Add Device" and offered a server
 *    **Mount Path** with a Browse button, which is the report that led here;
 *  - `pickFolder()` skipped its web short-circuit and went looking for a native
 *    dialog on the server;
 *  - the Sync panel never marked a device it could not reach;
 *  - and — oldest of the lot, from Phase 4 — the Devices panel's restore effect
 *    returned early, so folders this browser had already been granted were
 *    never re-opened on a revisit.
 *
 * The e2e specs missed the last one because they attach through the exposed
 * device client rather than through that effect, and missed the rest because
 * the daemon-backed assertions never read a label.
 *
 * So this pins the predicate itself, which is the one thing all of them share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh module graph per test: `activeTransport` is module state. */
async function freshTransport() {
  vi.resetModules();
  return import("../../renderer/ipc/web-transport");
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  delete (window as { api?: unknown }).api;
  // `installWebTransport()` asks the server for the auth state and, when
  // authenticated, opens a socket. Neither is what this file is about.
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as { api?: unknown }).api;
});

describe("isWebMode", () => {
  it("is true before bootstrap when there is no preload", async () => {
    const mod = await freshTransport();
    expect(mod.isWebMode()).toBe(true);
  });

  it("is false in Electron, where the preload installed window.api", async () => {
    const mod = await freshTransport();
    (window as { api?: unknown }).api = { invoke: () => {}, on: () => {} };
    expect(mod.isWebMode()).toBe(false);
  });

  it("stays true after installWebTransport, which installs window.api itself", async () => {
    // The regression, in one line. Before the fix this returned false, because
    // the thing it tests for absence is the thing bootstrap had just created.
    const mod = await freshTransport();
    expect(mod.isWebMode()).toBe(true);

    await mod.installWebTransport();

    expect((window as { api?: unknown }).api).toBeDefined();
    expect(mod.isWebMode()).toBe(true);
  });

  it("agrees with getWebTransport() about which world this is", async () => {
    // The two answer the same question, so a disagreement is always a bug —
    // and `activeTransport` is deliberately the single source for both.
    const mod = await freshTransport();
    expect(mod.getWebTransport()).toBeNull();

    await mod.installWebTransport();

    expect(mod.getWebTransport()).not.toBeNull();
    expect(mod.isWebMode()).toBe(true);
  });
});
