import { ipcMain } from "electron";
import { safe, getLibrary, validateFolderPath } from "./common";
import { LibraryScanner } from "../library/library-scanner";
import { getHarmonicPrefs } from "../utils/prefs";
import { logActivity, getRecentActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";

let activeScanAbort: AbortController | null = null;
let activeShadowBuildAbort: AbortController | null = null;

export function registerLibraryHandlers(): void {
  ipcMain.handle(
    "library:scan",
    safe("library:scan", async (event, payload: { folders: Array<{ name: string; path: string; contentType: string }> }) => {
      const lib = getLibrary();
      const scanner = new LibraryScanner(lib.getConnection());
      activeScanAbort = new AbortController();
      const harmonicPrefs = getHarmonicPrefs();

      let totalAdded = 0;
      let totalProcessed = 0;
      let totalRemoved = 0;

      const allErrors: string[] = [];
      const allAdded: string[] = [];
      const allUpdated: string[] = [];
      const allRemovedIds: number[] = [];
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
            activeScanAbort.signal,
            { scanHarmonicData: harmonicPrefs.scanHarmonicData }
          );
          totalAdded += result.filesAdded;
          totalProcessed += result.filesProcessed;
          totalRemoved += result.filesRemoved ?? 0;
          if (result.errors?.length) allErrors.push(...result.errors);
          if (result.addedTrackPaths?.length) allAdded.push(...result.addedTrackPaths);
          if (result.updatedTrackPaths?.length) allUpdated.push(...result.updatedTrackPaths);
          if (result.removedTrackIds?.length) allRemovedIds.push(...result.removedTrackIds);
          if (result.cancelled) {
            return {
              filesAdded: totalAdded,
              filesProcessed: totalProcessed,
              filesRemoved: totalRemoved,
              cancelled: true,
              errors: allErrors,
            };
          }
        }

        if (allAdded.length > 0 || allUpdated.length > 0 || allRemovedIds.length > 0) {
          lib
            .propagateScanToShadows(allAdded, allUpdated, allRemovedIds)
            .catch((err) => console.error("[ipc] Shadow propagation error:", err));
        }

        logActivity(
          getLibrary().getConnection(),
          "library_scan",
          `Scanned ${totalProcessed} files, ${totalAdded} added, ${totalRemoved} removed`
        );
        invalidateAssistantCache(); // F9: library changed, rebuild context on next chat
        return {
          filesAdded: totalAdded,
          filesProcessed: totalProcessed,
          filesRemoved: totalRemoved,
          cancelled: false,
          errors: allErrors,
        };
      } finally {
        activeScanAbort = null;
      }
    })
  );

  ipcMain.handle(
    "scan:cancel",
    safe("scan:cancel", async () => {
      if (activeScanAbort) {
        activeScanAbort.abort();
        activeScanAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );

  ipcMain.handle(
    "library:getTracks",
    safe("library:getTracks", async (_event, filter?: { contentType?: "music" | "podcast" | "audiobook"; limit?: number; offset?: number }) => {
      return getLibrary().getTracks(filter);
    })
  );

  ipcMain.handle(
    "library:getStats",
    safe("library:getStats", async () => getLibrary().getStats())
  );

  ipcMain.handle(
    "activity:getRecent",
    safe("activity:getRecent", async () => getRecentActivity(getLibrary().getConnection()))
  );

  ipcMain.handle(
    "library:getFolders",
    safe("library:getFolders", async () => getLibrary().getLibraryFolders())
  );

  ipcMain.handle(
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

  ipcMain.handle(
    "library:removeFolder",
    safe("library:removeFolder", async (_event, folderId: number) => {
      const ok = getLibrary().removeLibraryFolder(folderId, true);
      if (!ok) throw new Error("Folder not found or could not remove");
    })
  );

  ipcMain.handle(
    "library:clearContentHashes",
    safe("library:clearContentHashes", async () => getLibrary().clearContentHashes())
  );

  // ---- Shadow Libraries -------------------------------------------------

  ipcMain.handle(
    "shadow:getAll",
    safe("shadow:getAll", async () => getLibrary().getShadowLibraries())
  );

  ipcMain.handle(
    "shadow:create",
    safe("shadow:create", async (
      event,
      config: { name: string; path: string; codecConfigId: number; vbrEnabled?: boolean }
    ) => {
      const validated = validateFolderPath(config.path);
      if ("error" in validated) return { error: validated.error };

      const lib = getLibrary();
      const id = lib.createShadowLibrary(
        config.name,
        validated.path,
        config.codecConfigId,
        config.vbrEnabled ?? false
      );

      activeShadowBuildAbort = new AbortController();
      lib
        .buildShadowLibrary(
          id,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("shadow:buildProgress", progress);
            }
          },
          activeShadowBuildAbort.signal
        )
        .catch((err) => {
          console.error("[ipc] Shadow build error:", err);
        })
        .finally(() => {
          activeShadowBuildAbort = null;
        });

      return lib.getShadowLibraryById(id);
    })
  );

  ipcMain.handle(
    "shadow:delete",
    safe("shadow:delete", async (_event, shadowLibId: number, keepFilesOnDisk?: boolean) => {
      return getLibrary().deleteShadowLibrary(shadowLibId, !keepFilesOnDisk);
    })
  );

  ipcMain.handle(
    "shadow:rebuild",
    safe("shadow:rebuild", async (event, shadowLibId: number) => {
      const lib = getLibrary();
      const shadowLib = lib.getShadowLibraryById(shadowLibId);
      if (!shadowLib) return { error: "Shadow library not found" };

      activeShadowBuildAbort = new AbortController();
      lib
        .buildShadowLibrary(
          shadowLibId,
          (progress) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("shadow:buildProgress", progress);
            }
          },
          activeShadowBuildAbort.signal
        )
        .catch((err) => {
          console.error("[ipc] Shadow rebuild error:", err);
        })
        .finally(() => {
          activeShadowBuildAbort = null;
        });

      return { started: true };
    })
  );

  ipcMain.handle(
    "shadow:cancelBuild",
    safe("shadow:cancelBuild", async () => {
      if (activeShadowBuildAbort) {
        activeShadowBuildAbort.abort();
        activeShadowBuildAbort = null;
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );
}
