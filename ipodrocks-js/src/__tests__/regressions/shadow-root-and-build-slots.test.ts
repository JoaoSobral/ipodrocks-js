/**
 * @vitest-environment node
 *
 * Regression — three findings against the shadow-library channels (security
 * review, 2026-09-28).
 *
 * 1. **One abort slot for every build.** `shadow:create`, `shadow:rebuild`,
 *    `shadow:resumeBuild` and the startup resume all wrote one module-level
 *    controller without stopping what it held, and every build's `finally`
 *    nulled it whether or not it was still its own. N requests ran N builds —
 *    an encoder each, for hours — and cancel reached only the newest. Builds
 *    now hold a slot per library id, a second start for one library is
 *    refused, the total is capped, and cancel reaches what it names.
 * 2. **A shadow root is trusted as app-owned space.** The prune deletes every
 *    audio file under it that it cannot account for, the build writes
 *    `join(root, <library-relative path>)`, and delete-with-files sweeps it.
 *    Nothing stopped a web guest aiming one at the owner's library folder or
 *    `$HOME`. The root must now stay clear of the library, the app's data and
 *    the allowlisted roots themselves — checked at create *and* before each
 *    destructive operation, so a row from before the fix is covered — and the
 *    create/delete/prune channels are the owner's alone over the web.
 * 3. **Listing walked the root.** `totalBytes` was a synchronous,
 *    symlink-following `readdirSync`/`statSync` walk of the whole root on every
 *    `shadow:getAll`, which a root holding a link to its own ancestor turned
 *    into an indefinite hang of the one event loop. It is `SUM(file_size)` over
 *    the rows now.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  installElectronMock,
  setupIpcSession,
  type IpcSession,
} from "../harness/ipc-harness";
import {
  installMusicMetadataMock,
  resetMusicMetadataMock,
  registerFixture,
} from "../harness/music-metadata-mock";
import { canRunDbTests } from "../harness";

installElectronMock();
installMusicMetadataMock();

/**
 * An encoder that never finishes on its own: it resolves only when the build
 * is aborted. That is what keeps a build resident long enough to observe its
 * slot, which is the whole shape of finding 1.
 */
vi.mock("../../main/sync/sync-conversion", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    convertWithCodec: vi.fn(
      (_src: string, _dest: string, _s: unknown, _log: unknown, signal?: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          if (signal?.aborted) return resolve(false);
          signal?.addEventListener("abort", () => resolve(false));
        })
    ),
  };
});

const itDb = it.skipIf(!canRunDbTests);

type Created = { id?: number; error?: string };

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("shadow libraries: build slots, root guard, owner gate, size", () => {
  let session: IpcSession;
  let root: string;
  let userData: string;
  let libraryDir: string;
  let originalTrack: string;
  let codecConfigId: number;
  let ipcLibrary: typeof import("../../main/ipc/library");
  let common: typeof import("../../main/ipc/common");

  beforeEach(async () => {
    resetMusicMetadataMock();
    if (!canRunDbTests) return;
    // Under $HOME because validateFolderPath only admits the allowlisted roots.
    root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-test-shadow-guard-"));
    const userDataDir = path.join(root, "userdata");
    userData = path.join(userDataDir, "userData");
    libraryDir = path.join(root, "library");
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    session = await setupIpcSession({ userDataDir });
    ipcLibrary = await import("../../main/ipc/library");
    common = await import("../../main/ipc/common");

    originalTrack = path.join(libraryDir, "Artist", "Album", "01.mp3");
    fs.mkdirSync(path.dirname(originalTrack), { recursive: true });
    fs.writeFileSync(originalTrack, Buffer.alloc(300, 1));
    registerFixture(originalTrack, {
      title: "One",
      artist: "Artist",
      album: "Album",
      duration: 100,
      bitrate: 320,
      codec: "MP3",
    });
    const folder = { name: "Music", path: libraryDir, contentType: "music" };
    await session.invoke("library:addFolder", folder);
    await session.invoke("library:scan", { folders: [folder] });

    codecConfigId = (
      common
        .getLibraryDb()
        .prepare(
          `SELECT cc.id FROM codec_configurations cc
           JOIN codecs c ON cc.codec_id = c.id
           WHERE c.name = 'OPUS' ORDER BY cc.id LIMIT 1`
        )
        .get() as { id: number }
    ).id;
  });

  afterEach(async () => {
    if (!canRunDbTests) return;
    // Nothing may outlive the test holding a slot in a module graph the next
    // test will not see.
    await session.invoke("shadow:cancelBuild");
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 0, "builds to stop");
    session.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function dir(name: string): string {
    const p = path.join(root, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  async function create(name: string, p: string): Promise<Created> {
    return session.invoke<Created>("shadow:create", { name, path: p, codecConfigId });
  }

  /** A row written straight to the table, the way a pre-fix `shadow:create` left it. */
  function legacyRow(name: string, p: string): number {
    const info = common
      .getLibraryDb()
      .prepare(
        `INSERT INTO shadow_libraries (name, path, codec_config_id, vbr_enabled, status)
         VALUES (?, ?, ?, 0, 'ready')`
      )
      .run(name, p, codecConfigId);
    return Number(info.lastInsertRowid);
  }

  // -------------------------------------------------------------------------
  // 1. Build slots
  // -------------------------------------------------------------------------

  itDb("a second start for a library already building is refused, not stacked", async () => {
    const a = await create("A", dir("shadow-a"));
    expect(a.error).toBeUndefined();
    await waitFor(() => ipcLibrary.activeShadowBuildIds().includes(a.id!), "A to build");

    const again = await session.invoke<{ started?: boolean; error?: string }>(
      "shadow:rebuild",
      a.id
    );
    expect(again.error).toMatch(/already building/i);
    const resume = await session.invoke<{ error?: string }>("shadow:resumeBuild", a.id);
    expect(resume.error).toMatch(/already building/i);
    expect(ipcLibrary.activeShadowBuildIds()).toEqual([a.id]);
  });

  itDb("concurrent builds are capped, and a refused create leaves no row", async () => {
    const cap = ipcLibrary.MAX_CONCURRENT_SHADOW_BUILDS;
    const ids: number[] = [];
    for (let i = 0; i < cap; i++) {
      const c = await create(`L${i}`, dir(`shadow-${i}`));
      expect(c.error).toBeUndefined();
      ids.push(c.id!);
    }
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === cap, "cap builds");

    const over = await create("Over", dir("shadow-over"));
    expect(over.error).toMatch(/already building/i);
    const rows = common
      .getLibraryDb()
      .prepare("SELECT COUNT(*) AS n FROM shadow_libraries WHERE name = 'Over'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
    expect(ipcLibrary.activeShadowBuildIds().sort()).toEqual(ids.sort());
  });

  itDb("cancel with an id stops that build only, and its finish frees only its own slot", async () => {
    const a = await create("A", dir("shadow-a"));
    const b = await create("B", dir("shadow-b"));
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 2, "both builds");

    const cancelA = await session.invoke<{ cancelled: boolean }>("shadow:cancelBuild", a.id);
    expect(cancelA.cancelled).toBe(true);
    // The old slot was nulled by whichever build finished first, orphaning the
    // other. A's finish must leave B's entry, and so B's cancel, intact.
    await waitFor(
      () => !ipcLibrary.activeShadowBuildIds().includes(a.id!),
      "A to finish"
    );
    expect(ipcLibrary.activeShadowBuildIds()).toEqual([b.id]);

    const cancelB = await session.invoke<{ cancelled: boolean }>("shadow:cancelBuild", b.id);
    expect(cancelB.cancelled).toBe(true);
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 0, "B to finish");
  });

  itDb("cancel with no id stops every build, after any sequence of starts", async () => {
    const a = await create("A", dir("shadow-a"));
    const b = await create("B", dir("shadow-b"));
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 2, "both builds");
    await session.invoke("shadow:cancelBuild", a.id);
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 1, "A to stop");
    expect((await session.invoke<{ started?: boolean }>("shadow:rebuild", a.id)).started).toBe(
      true
    );
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 2, "A to restart");

    const all = await session.invoke<{ cancelled: boolean }>("shadow:cancelBuild");
    expect(all.cancelled).toBe(true);
    await waitFor(() => ipcLibrary.activeShadowBuildIds().length === 0, "every build to stop");
    expect(b.id).toBeDefined();

    // Nothing left to stop reads as such, rather than a false success.
    const none = await session.invoke<{ cancelled: boolean }>("shadow:cancelBuild");
    expect(none.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Root guard
  // -------------------------------------------------------------------------

  itDb("create refuses a root that overlaps the library, the app's data or $HOME", async () => {
    const refused: Array<[string, string]> = [
      ["the library folder", libraryDir],
      ["inside the library folder", path.join(libraryDir, "Artist")],
      ["above the library folder", root],
      ["the app's data directory", userData],
      ["inside the app's data directory", dir("userdata/userData/shadow")],
      ["the home directory itself", os.homedir()],
    ];
    for (const [why, p] of refused) {
      const res = await create(`Bad ${why}`, p);
      expect(res.error, why).toMatch(/dedicated folder/i);
    }
    const rows = common
      .getLibraryDb()
      .prepare("SELECT COUNT(*) AS n FROM shadow_libraries")
      .get() as { n: number };
    expect(rows.n).toBe(0);

    // A symlinked spelling of the library folder is the library folder.
    const link = path.join(root, "link-to-library");
    fs.symlinkSync(libraryDir, link, "dir");
    expect((await create("Via link", link)).error).toMatch(/dedicated folder/i);

    // Control: a sibling folder of its own is exactly what a shadow root is.
    const ok = await create("Fine", dir("shadow-ok"));
    expect(ok.error).toBeUndefined();
    expect(ok.id).toBeGreaterThan(0);
  });

  itDb("a pre-fix row aimed at the library folder cannot be pruned, built or file-deleted", async () => {
    const id = legacyRow("Legacy", libraryDir);
    // A `shadow_tracks` row pointing at the original, as a same-extension
    // build over the library folder would have written.
    const trackId = (
      common.getLibraryDb().prepare("SELECT id FROM tracks LIMIT 1").get() as { id: number }
    ).id;
    common
      .getLibraryDb()
      .prepare(
        `INSERT INTO shadow_tracks (shadow_library_id, source_track_id, shadow_path, status, file_size)
         VALUES (?, ?, ?, 'synced', 300)`
      )
      .run(id, trackId, originalTrack);
    const untracked = path.join(libraryDir, "Other", "02.mp3");
    fs.mkdirSync(path.dirname(untracked), { recursive: true });
    fs.writeFileSync(untracked, Buffer.alloc(10));

    const pruned = await session.invoke<{ error?: string; deleted?: number }>(
      "shadow:pruneOrphans",
      id
    );
    expect(pruned.error).toMatch(/cannot be pruned/i);
    expect(fs.existsSync(untracked)).toBe(true);

    const rebuilt = await session.invoke<{ error?: string }>("shadow:rebuild", id);
    expect(rebuilt.error).toMatch(/cannot be rebuilt/i);
    const resumed = await session.invoke<{ error?: string }>("shadow:resumeBuild", id);
    expect(resumed.error).toMatch(/cannot be resumed/i);
    expect(ipcLibrary.activeShadowBuildIds()).toEqual([]);

    // Delete still removes the row — the owner has to be able to get rid of
    // it — but no file under the library is touched.
    const deleted = await session.invoke<boolean>("shadow:delete", id, false);
    expect(deleted).toBe(true);
    expect(fs.existsSync(originalTrack)).toBe(true);
    expect(fs.existsSync(untracked)).toBe(true);
    expect(fs.existsSync(libraryDir)).toBe(true);
    const left = common
      .getLibraryDb()
      .prepare("SELECT COUNT(*) AS n FROM shadow_libraries WHERE id = ?")
      .get(id) as { n: number };
    expect(left.n).toBe(0);
  });

  itDb("a scan never transcodes into, or deletes from, an overlapping root", async () => {
    const id = legacyRow("Legacy", root);
    const mgr = common.getLibrary().getShadowManager();
    expect(mgr.rootConflictFor(id)).toMatch(/contains/i);

    const conv = (await import("../../main/sync/sync-conversion")).convertWithCodec as unknown as {
      mock: { calls: unknown[] };
    };
    const before = conv.mock.calls.length;
    await mgr.propagateAddedOrUpdated(
      [originalTrack],
      (p) => common.getLibrary().getTrackByPath(p),
      new Map(common.getLibrary().getLibraryFolders().map((f) => [f.id, f.path]))
    );
    expect(conv.mock.calls.length).toBe(before);

    expect(mgr.deleteOrphanedShadowFiles([originalTrack])).toBe(0);
    expect(fs.existsSync(originalTrack)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Owner gate
  // -------------------------------------------------------------------------

  itDb("a non-owner web session cannot create, delete or prune a shadow library", async () => {
    const shadowDir = dir("shadow-owned");
    const stale = path.join(shadowDir, "Gone", "01.opus");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, Buffer.alloc(10));
    const id = legacyRow("Owned", shadowDir);

    const created = await session.invokeAsWebClient<Created>("shadow:create", {
      name: "Guest's",
      path: dir("shadow-guest"),
      codecConfigId,
    });
    expect(created.error).toMatch(/owner/i);

    const pruned = await session.invokeAsWebClient<{ error?: string }>("shadow:pruneOrphans", id);
    expect(pruned.error).toMatch(/owner/i);
    expect(fs.existsSync(stale)).toBe(true);

    const deleted = await session.invokeAsWebClient<{ error?: string }>("shadow:delete", id, false);
    expect(deleted.error).toMatch(/owner/i);
    expect(common.getLibrary().getShadowLibraryById(id)).toBeDefined();
    expect(ipcLibrary.activeShadowBuildIds()).toEqual([]);

    // Rocksy is the same front door: the tools re-apply the gate in run().
    const tools = await import("../../main/assistant/tools");
    const ctx = {
      sessionId: "harness-web-session",
      db: common.getLibraryDb(),
      getLibrary: () => common.getLibrary(),
    } as unknown as import("../../main/assistant/tools").AiToolContext;
    const toolPrune = (await tools.getToolByName("shadow_prune_orphans")!.run(
      { shadowLibraryId: id },
      ctx
    )) as { ok: boolean; error?: string };
    expect(toolPrune.ok).toBe(false);
    expect(toolPrune.error).toMatch(/owner/i);
    const toolDelete = (await tools.getToolByName("shadow_delete")!.run(
      { shadowLibraryId: id },
      ctx
    )) as { ok: boolean; error?: string };
    expect(toolDelete.ok).toBe(false);
    expect(fs.existsSync(stale)).toBe(true);
    expect(common.getLibrary().getShadowLibraryById(id)).toBeDefined();

    // Control: the desktop window (no session) is the owner by construction.
    const ownerPrune = await session.invoke<{ deleted?: number; error?: string }>(
      "shadow:pruneOrphans",
      id
    );
    expect(ownerPrune.error).toBeUndefined();
    expect(ownerPrune.deleted).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Size without a walk
  // -------------------------------------------------------------------------

  itDb("listing reports the recorded size and never walks the root", async () => {
    const shadowDir = dir("shadow-size");
    // A directory link back to an ancestor: the old walk followed it at every
    // level until the path overflowed. And an untracked file the listing has
    // no business counting.
    fs.symlinkSync(root, path.join(shadowDir, "loop"), "dir");
    fs.writeFileSync(path.join(shadowDir, "stray.bin"), Buffer.alloc(50_000));
    const id = legacyRow("Sized", shadowDir);
    const trackId = (
      common.getLibraryDb().prepare("SELECT id FROM tracks LIMIT 1").get() as { id: number }
    ).id;
    common
      .getLibraryDb()
      .prepare(
        `INSERT INTO shadow_tracks (shadow_library_id, source_track_id, shadow_path, status, file_size)
         VALUES (?, ?, ?, 'synced', 1234)`
      )
      .run(id, trackId, path.join(shadowDir, "Artist", "Album", "01.opus"));

    // 1234 and not 51234: the stray file would only be counted by a walk.
    const all = await session.invoke<Array<{ id: number; totalBytes: number }>>("shadow:getAll");
    expect(all.find((l) => l.id === id)?.totalBytes).toBe(1234);
  });
  // -------------------------------------------------------------------------
  // Cancel reaches only what the caller may stop
  // -------------------------------------------------------------------------

  itDb("a guest's cancel does not pause the owner's build; its own build it may stop", async () => {
    const owners = await create("Owner's", dir("shadow-owner"));
    await waitFor(() => ipcLibrary.activeShadowBuildIds().includes(owners.id!), "owner build");

    // The bare form is what the renderer's "Pause Build" sends.
    const bare = await session.invokeAsWebClient<{ cancelled?: boolean }>("shadow:cancelBuild");
    expect(bare.cancelled).toBe(false);
    const named = await session.invokeAsWebClient<{ error?: string }>(
      "shadow:cancelBuild",
      owners.id
    );
    expect(named.error).toMatch(/someone else/i);
    await new Promise((r) => setTimeout(r, 50));
    expect(ipcLibrary.activeShadowBuildIds()).toContain(owners.id);

    // A build the guest started is theirs to stop.
    const guestsId = legacyRow("Guest's", dir("shadow-guests"));
    const started = await session.invokeAsWebClient<{ started?: boolean; error?: string }>(
      "shadow:rebuild",
      guestsId
    );
    expect(started.error).toBeUndefined();
    await waitFor(() => ipcLibrary.activeShadowBuildIds().includes(guestsId), "guest build");
    const own = await session.invokeAsWebClient<{ cancelled?: boolean }>("shadow:cancelBuild");
    expect(own.cancelled).toBe(true);
    await waitFor(() => !ipcLibrary.activeShadowBuildIds().includes(guestsId), "guest build to stop");
    expect(ipcLibrary.activeShadowBuildIds()).toContain(owners.id);
  });

  itDb("one library scan at a time, and a guest cannot cancel the owner's", async () => {
    const folder = { name: "Music", path: libraryDir, contentType: "music" };
    // The handler claims the slot before its first await, so the first scan
    // holds it by the time the second call is made.
    const first = session.invoke<{ cancelled?: boolean; error?: string }>("library:scan", {
      folders: [folder],
    });
    // Neither call is awaited before the other is made: a one-file scan
    // finishes quickly, and the point is to reach it while it runs.
    const secondP = session.invoke<{ error?: string }>("library:scan", { folders: [folder] });
    const guestCancelP = session.invokeAsWebClient<{ error?: string }>("scan:cancel");
    expect((await secondP).error).toMatch(/already running/i);
    expect((await guestCancelP).error).toMatch(/someone else/i);
    const done = await first;
    expect(done.error).toBeUndefined();
    expect(done.cancelled).toBe(false);

    // Released by its own finally: the next scan is admitted.
    const again = await session.invoke<{ error?: string }>("library:scan", { folders: [folder] });
    expect(again.error).toBeUndefined();
  });
});
