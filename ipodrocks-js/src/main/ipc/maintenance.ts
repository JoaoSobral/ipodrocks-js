/**
 * One-shot maintenance jobs the user runs by hand from Settings.
 *
 * These are library-wide repairs for defects that shipped: they walk files
 * iPodRocks itself wrote and fix them in place, rather than making the user
 * rebuild or re-sync. Everything here is cancellable and streams progress,
 * because a real library is thousands of files.
 */

import { ipcMain } from "electron";
import * as fs from "fs";

import { safe, getLibrary, getDevicesCore } from "./common";
import { logActivity } from "../activity/activity-logger";
import { repairMpcTagsInTree, type RepairScanResult } from "../tagging/mpc/repair-scan";
import { makeShadowSourceResolver } from "../library/shadow-replaygain-source";
import type { ContentType } from "../../shared/types";

let activeRepairAbort: AbortController | null = null;

/** Content folders on a device that can hold transcoded Musepack files. */
const DEVICE_CONTENT_TYPES: ContentType[] = ["music", "podcast", "audiobook"];

export interface MpcRepairScope {
  /** "Shadow library: Opus 128" / "Device: iPod Video". */
  label: string;
  scanned: number;
  repaired: number;
  failed: number;
}

export interface MpcRepairSummary extends RepairScanResult {
  scopes: MpcRepairScope[];
  cancelled: boolean;
}

export interface MpcRepairProgress {
  /** Scope currently being walked. */
  label: string;
  scanned: number;
  repaired: number;
  failed: number;
  currentFile: string;
}

export function registerMaintenanceHandlers(): void {
  ipcMain.handle(
    "maintenance:repairMpcTags",
    safe("maintenance:repairMpcTags", async (event) => {
      if (activeRepairAbort) return { error: "A tag repair is already running." };

      const lib = getLibrary();
      activeRepairAbort = new AbortController();
      const signal = activeRepairAbort.signal;

      const scopes: MpcRepairScope[] = [];
      const total: RepairScanResult = { scanned: 0, repaired: 0, failed: 0 };

      // Roots are collected first so the summary can name every scope even when
      // one of them turns out to be empty or unreachable.
      const db = lib.getConnection();
      const roots: Array<{
        label: string;
        path: string;
        /** Only a shadow library can resolve a file back to its source track. */
        shadowLibraryId?: number;
      }> = [];

      for (const shadow of lib.getShadowLibraries()) {
        if (shadow.path) {
          roots.push({
            label: `Shadow library: ${shadow.name}`,
            path: shadow.path,
            shadowLibraryId: shadow.id,
          });
        }
      }

      // Device files cannot be resolved back to a library track:
      // `device_synced_tracks.device_path` is mount-relative and casefolded, so
      // it cannot be matched against the absolute paths this walk yields. They
      // are still repaired in full from what they carry themselves — the
      // artwork comes out, and their own `REPLAYGAIN_*` items go into the
      // stream header (#137). That matters here: a header-only repair changes
      // neither size nor mtime, so no sync would ever re-copy a fixed shadow
      // copy over a stale device one. Only the source-resolved top-up, for a
      // file whose tag lost its ReplayGain entirely, stays shadow-only.
      for (const device of getDevicesCore().getDevices()) {
        if (!device.mountPath) continue;
        for (const contentType of DEVICE_CONTENT_TYPES) {
          const contentPath = device.getContentPath(contentType);
          if (contentPath) {
            roots.push({
              label: `Device: ${device.name} (${contentType})`,
              path: contentPath,
            });
          }
        }
      }

      const updateShadowStat = db.prepare(
        `UPDATE shadow_tracks
            SET file_size = ?, mtime = ?
          WHERE shadow_library_id = ? AND shadow_path = ?`
      );

      try {
        for (const root of roots) {
          if (signal.aborted) break;

          const result = await repairMpcTagsInTree(root.path, {
            cancelSignal: signal,
            replayGainFor:
              root.shadowLibraryId != null
                ? makeShadowSourceResolver(db, root.shadowLibraryId)
                : undefined,
            onRepaired: (mpcPath, newSize) => {
              // The repair changes the file's size, so the stat baseline the
              // reconcile pass trusts is now stale. Left alone it would treat
              // every repaired file as a candidate to re-probe on the next
              // build. The mtime is unchanged by the repair, so re-use it.
              if (root.shadowLibraryId == null) return;
              try {
                const mtime = Math.floor(fs.statSync(mpcPath).mtimeMs);
                updateShadowStat.run(newSize, mtime, root.shadowLibraryId, mpcPath);
              } catch {
                /* the next reconcile re-probes it; not worth failing over */
              }
            },
            onProgress: (p) => {
              if (event.sender.isDestroyed()) return;
              event.sender.send("maintenance:repairProgress", {
                label: root.label,
                scanned: total.scanned + p.scanned,
                repaired: total.repaired + p.repaired,
                failed: total.failed + p.failed,
                currentFile: p.currentFile,
              } satisfies MpcRepairProgress);
            },
          });

          // A scope that held no Musepack files at all is noise in the summary.
          if (result.scanned > 0) scopes.push({ label: root.label, ...result });
          total.scanned += result.scanned;
          total.repaired += result.repaired;
          total.failed += result.failed;
        }

        if (total.repaired > 0) {
          logActivity(
            lib.getConnection(),
            "mpc_tag_repair",
            `Repaired Musepack tags in ${total.repaired} file(s) across ${scopes.length} location(s)`
          );
        }

        return {
          ...total,
          scopes,
          cancelled: signal.aborted,
        } satisfies MpcRepairSummary;
      } finally {
        activeRepairAbort = null;
      }
    })
  );

  ipcMain.handle(
    "maintenance:cancelRepairMpcTags",
    safe("maintenance:cancelRepairMpcTags", async () => {
      if (activeRepairAbort) {
        activeRepairAbort.abort();
        return { cancelled: true };
      }
      return { cancelled: false };
    })
  );
}
