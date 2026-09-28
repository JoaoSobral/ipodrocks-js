import { handle as bridgeHandle, type HandlerContext, type HandlerSender } from "../host/bridge";
import { safe, getLibrary, getPlaylistCore, validateFolderPath } from "./common";
import { denyIfNotOwner } from "../../server/auth/sessions";
import { LibraryScanner } from "../library/library-scanner";
import { getHarmonicPrefs, getRatingPrefs } from "../utils/prefs";
import { logActivity, getRecentActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";

/**
 * The running library scan and the session that started it.
 *
 * One at a time: a scan walks every folder and writes the whole library, so a
 * second one only races the first over the same rows — and this was a single
 * variable every start overwrote, which left the earlier scan with no cancel
 * handle at all. `sessionId` is what lets `scan:cancel` refuse a guest trying
 * to stop somebody else's scan.
 */
let activeScan: { controller: AbortController; sessionId: string | undefined } | null = null;

/**
 * May this caller stop an operation `startedBy` started? The desktop window
 * and the server's owner may stop anything; any other web session only what it
 * started itself. Without this a guest's bare "cancel" reached every running
 * build or scan on the server — the `sync:cancel` finding, in another shape.
 */
function mayStop(event: HandlerContext, startedBy: string | undefined): boolean {
  if (!denyIfNotOwner(event.sessionId)) return true;
  return startedBy !== undefined && startedBy === event.sessionId;
}

/**
 * Running shadow builds, keyed by shadow library id.
 *
 * This was one module-level controller: every start overwrote it without
 * stopping what it held, and every finish nulled it whether or not it was still
 * its own. So N starts ran N builds — one encoder each, for hours — and cancel
 * reached only the newest, or nothing once any build had finished. Per id, a
 * finish removes only its own entry, and a second start for the same library
 * is refused instead of stacked.
 */
const activeShadowBuilds = new Map<number, AbortController>();

/** Which session started each build — `undefined` for the desktop and the startup resume. */
const shadowBuildStarter = new WeakMap<AbortController, string | undefined>();

/**
 * How many shadow builds may run at once, across every client.
 *
 * Each build runs one encoder at a time for the length of the library, so this
 * is the number of CPU-bound ffmpeg/mpcenc processes shadow libraries can ever
 * hold. Two lets the owner build two mirrors side by side (say an MPC and an
 * AAC one) — the most anyone has asked for — while keeping any number of
 * requests from multiplying that. The startup resume pass takes one slot and
 * runs its libraries one after another, so the user still has one free.
 */
export const MAX_CONCURRENT_SHADOW_BUILDS = 2;

/** Claim a build slot for `id`, or say why not. */
function claimShadowBuild(id: number): AbortController | { error: string } {
  if (activeShadowBuilds.has(id)) {
    return { error: "This shadow library is already building." };
  }
  if (activeShadowBuilds.size >= MAX_CONCURRENT_SHADOW_BUILDS) {
    return {
      error: `${activeShadowBuilds.size} shadow libraries are already building — wait for one to finish or pause it, then try again.`,
    };
  }
  const controller = new AbortController();
  activeShadowBuilds.set(id, controller);
  return controller;
}

/** Release `id`'s slot — but only if it still holds this build's controller. */
function releaseShadowBuild(id: number, controller: AbortController): void {
  if (activeShadowBuilds.get(id) === controller) activeShadowBuilds.delete(id);
}

/** Test seam: ids of the builds currently holding a slot. */
export function activeShadowBuildIds(): number[] {
  return [...activeShadowBuilds.keys()];
}

/**
 * Start a background build for `id` in a claimed slot. Returns the refusal
 * instead when the library is already building or the cap is reached.
 */
function startShadowBuild(
  id: number,
  sender: HandlerSender,
  label: string,
  sessionId: string | undefined
): { started: true } | { error: string } {
  const claim = claimShadowBuild(id);
  if ("error" in claim) return claim;
  shadowBuildStarter.set(claim, sessionId);
  getLibrary()
    .buildShadowLibrary(
      id,
      (progress) => {
        if (!sender.isDestroyed()) sender.send("shadow:buildProgress", progress);
      },
      claim.signal
    )
    .catch((err) => {
      console.error(`[ipc] ${label} error:`, err);
    })
    .finally(() => releaseShadowBuild(id, claim));
  return { started: true };
}

/**
 * Creating, deleting and pruning a shadow library act on the *server's*
 * filesystem at a folder the caller names, so over the web they are the
 * owner's alone — the same `denyIfNotOwner()` the `server:*` channels use.
 * `sessionId === undefined` is the desktop window and is admitted.
 */
function requireShadowOwner(event: HandlerContext): { error: string } | null {
  if (!denyIfNotOwner(event.sessionId)) return null;
  return { error: "Only the server's owner can create, delete or prune shadow libraries." };
}

/**
 * Re-sync every playlist with the library after tracks may have disappeared.
 *
 * Runs after a completed scan and after a folder removal so the user never has
 * to notice a "broken playlists" banner and click Repair by hand. Failures are
 * logged and swallowed: reconciliation is a tidy-up pass, and a problem here
 * must not fail the scan that just succeeded.
 */
function reconcilePlaylistsAfterLibraryChange(context: string) {
  try {
    const summary = getPlaylistCore().reconcileAllPlaylists();
    if (summary.prunedItems > 0 || summary.rebuiltSmart > 0) {
      logActivity(
        getLibrary().getConnection(),
        "playlist_repaired",
        `Auto-updated playlists after ${context}: removed ${summary.prunedItems} missing tracks from ${summary.prunedPlaylists} playlist(s), rebuilt ${summary.rebuiltSmart} smart playlist(s)`
      );
      invalidateAssistantCache();
    }
    return summary;
  } catch (err) {
    console.error("[ipc] Playlist reconciliation error:", err);
    return { prunedItems: 0, prunedPlaylists: 0, rebuiltSmart: 0 };
  }
}

export function registerLibraryHandlers(): void {
  bridgeHandle(
    "library:scan",
    safe("library:scan", async (event, payload: { folders: Array<{ name: string; path: string; contentType: string }> }) => {
      const lib = getLibrary();
      if (activeScan) return { error: "A library scan is already running." };
      const scanner = new LibraryScanner(lib.getConnection());
      const scan = { controller: new AbortController(), sessionId: event.sessionId };
      activeScan = scan;
      const harmonicPrefs = getHarmonicPrefs();
      const ratingPrefs = getRatingPrefs();

      let totalAdded = 0;
      let totalProcessed = 0;
      let totalRemoved = 0;

      const allErrors: string[] = [];
      const allWarnings: string[] = [];
      let totalDuplicateFiles = 0;
      const allAdded: string[] = [];
      const allUpdated: string[] = [];
      const allRemovedIds: number[] = [];
      const allRemovedShadowPaths: string[] = [];
      try {
        for (const folder of payload.folders) {
          const validated = validateFolderPath(folder.path);
          if ("error" in validated) {
            allErrors.push(`${folder.name}: ${validated.error}`);
            continue;
          }
          const result = await scanner.scanFolder(
            validated.path,
            folder.contentType,
            (progress) => event.sender.send("scan:progress", progress),
            scan.controller.signal,
            {
              scanHarmonicData: harmonicPrefs.scanHarmonicData,
              forceRatingFromTags: ratingPrefs.tagRatingAlwaysWins,
            }
          );
          totalAdded += result.filesAdded;
          totalProcessed += result.filesProcessed;
          totalRemoved += result.filesRemoved ?? 0;
          if (result.errors?.length) allErrors.push(...result.errors);
          if (result.warnings?.length) allWarnings.push(...result.warnings);
          totalDuplicateFiles += result.duplicateFilesDetected ?? 0;
          if (result.addedTrackPaths?.length) allAdded.push(...result.addedTrackPaths);
          if (result.updatedTrackPaths?.length) allUpdated.push(...result.updatedTrackPaths);
          if (result.removedTrackIds?.length) allRemovedIds.push(...result.removedTrackIds);
          if (result.removedShadowPaths?.length)
            allRemovedShadowPaths.push(...result.removedShadowPaths);
          if (result.cancelled) {
            return {
              filesAdded: totalAdded,
              filesProcessed: totalProcessed,
              filesRemoved: totalRemoved,
              cancelled: true,
              errors: allErrors,
              warnings: allWarnings,
              duplicateFilesDetected: totalDuplicateFiles,
            };
          }
        }

        if (
          allAdded.length > 0 ||
          allUpdated.length > 0 ||
          allRemovedIds.length > 0 ||
          allRemovedShadowPaths.length > 0
        ) {
          lib
            .propagateScanToShadows(
              allAdded,
              allUpdated,
              allRemovedIds,
              undefined,
              allRemovedShadowPaths
            )
            .catch((err) => console.error("[ipc] Shadow propagation error:", err));
        }

        logActivity(
          getLibrary().getConnection(),
          "library_scan",
          `Scanned ${totalProcessed} files, ${totalAdded} added, ${totalRemoved} removed`
        );
        invalidateAssistantCache(); // F9: library changed, rebuild context on next chat

        // Keep playlists honest: drop songs that no longer exist and re-resolve
        // smart playlists so they also pick up whatever this scan just added.
        const playlistSummary = reconcilePlaylistsAfterLibraryChange("library scan");

        return {
          filesAdded: totalAdded,
          filesProcessed: totalProcessed,
          filesRemoved: totalRemoved,
          cancelled: false,
          errors: allErrors,
          warnings: allWarnings,
          duplicateFilesDetected: totalDuplicateFiles,
          playlistsUpdated: playlistSummary,
        };
      } finally {
        if (activeScan === scan) activeScan = null;
      }
    })
  );

  bridgeHandle(
    "scan:cancel",
    safe("scan:cancel", async (event) => {
      // The slot is released by the scan's own `finally`, so a new scan cannot
      // start while this one is still unwinding.
      if (!activeScan) return { cancelled: false };
      if (!mayStop(event, activeScan.sessionId)) {
        return { error: "This library scan was started by someone else." };
      }
      activeScan.controller.abort();
      return { cancelled: true };
    })
  );

  bridgeHandle(
    "library:getTracks",
    safe("library:getTracks", async (_event, filter?: { contentType?: "music" | "podcast" | "audiobook"; limit?: number; offset?: number }) => {
      return getLibrary().getTracks(filter);
    })
  );

  bridgeHandle(
    "library:getStats",
    safe("library:getStats", async () => getLibrary().getStats())
  );

  bridgeHandle(
    "activity:getRecent",
    safe("activity:getRecent", async () => getRecentActivity(getLibrary().getConnection()))
  );

  bridgeHandle(
    "library:getFolders",
    safe("library:getFolders", async () => getLibrary().getLibraryFolders())
  );

  bridgeHandle(
    "library:addFolder",
    safe("library:addFolder", async (_event, folder: { name: string; path: string; contentType: "music" | "podcast" | "audiobook" }) => {
      const validated = validateFolderPath(folder.path);
      if ("error" in validated) return { error: validated.error };
      const result = getLibrary().addLibraryFolder(
        folder.name,
        validated.path,
        folder.contentType
      );
      logActivity(
        getLibrary().getConnection(),
        "add_folder",
        `Added folder: ${folder.name} (${validated.path})`
      );
      return result;
    })
  );

  bridgeHandle(
    "library:removeFolder",
    safe("library:removeFolder", async (_event, folderId: number) => {
      const ok = getLibrary().removeLibraryFolder(folderId, true);
      if (!ok) throw new Error("Folder not found or could not remove");
      reconcilePlaylistsAfterLibraryChange("folder removal");
    })
  );

  bridgeHandle(
    "library:clearContentHashes",
    safe("library:clearContentHashes", async () => getLibrary().clearContentHashes())
  );

  // ---- Shadow Libraries -------------------------------------------------

  bridgeHandle(
    "shadow:getAll",
    safe("shadow:getAll", async () => getLibrary().getShadowLibraries())
  );

  bridgeHandle(
    "shadow:create",
    safe("shadow:create", async (
      event,
      config: { name: string; path: string; codecConfigId: number; vbrEnabled?: boolean }
    ) => {
      const denied = requireShadowOwner(event);
      if (denied) return denied;
      const validated = validateFolderPath(config.path);
      if ("error" in validated) return { error: validated.error };

      const lib = getLibrary();

      // name and path are both UNIQUE. Say so in words — the raw constraint
      // message ("UNIQUE constraint failed: shadow_libraries.path") tells the
      // user nothing about what to do. Checked against the raw table (not
      // getShadowLibraries()) so a row whose codec config was lost — invisible
      // to that joined listing — still gets caught here instead of reaching
      // the INSERT and throwing that raw message anyway.
      const conflict = lib.findConflictingShadowLibrary(config.name, validated.path);
      if (conflict) {
        if (conflict.field === "path") {
          return {
            error: `"${conflict.name}" already uses this folder — manage it from the shadow libraries list instead of creating a new one (rebuild reuses files already encoded; delete if it's stuck).`,
          };
        }
        return { error: `A shadow library named "${config.name}" already exists.` };
      }

      // The root must be a folder of its own: not a library folder, not
      // inside or above one, not the app's data, not $HOME itself. Every
      // destructive shadow operation trusts it as app-owned space.
      const rootConflict = lib.getShadowManager().rootConflict(validated.path);
      if (rootConflict) return { error: rootConflict };

      // Refuse before the row exists, so a refused build does not leave a
      // 'pending' library behind.
      if (activeShadowBuilds.size >= MAX_CONCURRENT_SHADOW_BUILDS) {
        return {
          error: `${activeShadowBuilds.size} shadow libraries are already building — wait for one to finish or pause it, then create this one.`,
        };
      }

      const id = lib.createShadowLibrary(
        config.name,
        validated.path,
        config.codecConfigId,
        config.vbrEnabled ?? false
      );

      const started = startShadowBuild(id, event.sender, "Shadow build", event.sessionId);
      if ("error" in started) return started;

      return lib.getShadowLibraryById(id);
    })
  );

  bridgeHandle(
    "shadow:delete",
    safe("shadow:delete", async (event, shadowLibId: number, keepFilesOnDisk?: boolean) => {
      const denied = requireShadowOwner(event);
      if (denied) return denied;
      // A build still writing into the folder would recreate what we delete
      // and then fail on its next row insert; stop it first.
      activeShadowBuilds.get(shadowLibId)?.abort();
      return getLibrary().deleteShadowLibrary(shadowLibId, !keepFilesOnDisk);
    })
  );

  bridgeHandle(
    "shadow:pruneOrphans",
    safe("shadow:pruneOrphans", async (event, shadowLibId: number) => {
      const denied = requireShadowOwner(event);
      if (denied) return denied;
      const lib = getLibrary();
      const result = await lib.getShadowManager().pruneOrphanedFiles(shadowLibId);
      const shadowLib = lib.getShadowLibraryById(shadowLibId);
      if (result.deleted > 0) {
        logActivity(
          lib.getConnection(),
          "shadow_prune",
          `Pruned ${result.deleted} orphaned file(s) from shadow library: ${shadowLib?.name ?? shadowLibId}`
        );
      }
      return result;
    })
  );

  bridgeHandle(
    "shadow:rebuild",
    safe("shadow:rebuild", async (event, shadowLibId: number) => {
      const lib = getLibrary();
      const shadowLib = lib.getShadowLibraryById(shadowLibId);
      if (!shadowLib) return { error: "Shadow library not found" };
      // buildShadowLibrary() would throw "Codec configuration not found" here,
      // but that rejection is only console.error'd below — the user would see
      // nothing happen. Report it up front instead.
      if (shadowLib.codecConfigMissing) {
        return {
          error: `"${shadowLib.name}" has lost its codec configuration and can't be rebuilt. Delete it and create a new shadow library at the same folder — the existing files will be adopted automatically.`,
        };
      }
      // Checked here as well as inside the build, so the refusal reaches the
      // caller instead of only the log.
      const rootConflict = lib.getShadowManager().rootConflictFor(shadowLibId);
      if (rootConflict) return { error: `"${shadowLib.name}" cannot be rebuilt: ${rootConflict}` };

      return startShadowBuild(shadowLibId, event.sender, "Shadow rebuild", event.sessionId);
    })
  );

  bridgeHandle(
    "shadow:cancelBuild",
    safe("shadow:cancelBuild", async (event, shadowLibId?: number) => {
      // With an id, stop that build; without one, stop them all — which is
      // what the renderer's single "Pause Build" has always meant. The entries
      // are released by each build's own `finally`, not here, so a slot is
      // not handed out again while its encoder is still being killed.
      // "All" means all the caller may stop (`mayStop`): a guest's Pause
      // must not pause the owner's builds.
      if (typeof shadowLibId === "number") {
        const controller = activeShadowBuilds.get(shadowLibId);
        if (!controller) return { cancelled: false };
        if (!mayStop(event, shadowBuildStarter.get(controller))) {
          return { error: "This shadow build was started by someone else." };
        }
        controller.abort();
        return { cancelled: true };
      }
      let cancelled = false;
      for (const controller of activeShadowBuilds.values()) {
        if (!mayStop(event, shadowBuildStarter.get(controller))) continue;
        controller.abort();
        cancelled = true;
      }
      return { cancelled };
    })
  );

  bridgeHandle(
    "shadow:resumeBuild",
    safe("shadow:resumeBuild", async (event, shadowLibId: number) => {
      const lib = getLibrary();
      const shadowLib = lib.getShadowLibraryById(shadowLibId);
      if (!shadowLib) return { error: "Shadow library not found" };
      if (shadowLib.codecConfigMissing) {
        return {
          error: `"${shadowLib.name}" has lost its codec configuration and can't be resumed. Delete it and create a new shadow library at the same folder — the existing files will be adopted automatically.`,
        };
      }
      const rootConflict = lib.getShadowManager().rootConflictFor(shadowLibId);
      if (rootConflict) return { error: `"${shadowLib.name}" cannot be resumed: ${rootConflict}` };

      return startShadowBuild(shadowLibId, event.sender, "Shadow resume", event.sessionId);
    })
  );
}

/**
 * On startup, resume any shadow-library build that was interrupted (paused by
 * the user, or left mid-build by a crash/force-quit). Interrupted 'building'
 * rows are first demoted to 'paused', then every paused library is rebuilt
 * sequentially in the background — resumption is cheap because already-synced
 * tracks are skipped. Progress is streamed to the given window's webContents.
 */
export async function resumeInterruptedShadowBuilds(
  webContents: HandlerSender
): Promise<void> {
  const lib = getLibrary();
  lib.markInterruptedShadowBuildsPaused();

  const paused = lib
    .getShadowLibraries()
    .filter((l) => l.status === "paused");

  for (const sl of paused) {
    // Through the same slots as every other build, so the cap and the
    // already-building refusal hold here too and "Pause Build" reaches it.
    const claim = claimShadowBuild(sl.id);
    if ("error" in claim) {
      console.warn(`[ipc] Shadow resume of #${sl.id} skipped: ${claim.error}`);
      continue;
    }
    try {
      await lib.buildShadowLibrary(
        sl.id,
        (progress) => {
          if (!webContents.isDestroyed()) {
            webContents.send("shadow:buildProgress", progress);
          }
        },
        claim.signal
      );
    } catch (err) {
      console.error("[ipc] Shadow resume error:", err);
    } finally {
      releaseShadowBuild(sl.id, claim);
    }
    // "Pause Build" stops the whole resume pass, not just the library it
    // happened to be on — otherwise the next paused library starts at once.
    if (claim.signal.aborted) break;
  }
}
