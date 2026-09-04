/**
 * One-shot maintenance jobs the user runs by hand from Settings.
 *
 * These are library-wide repairs for defects that shipped: they walk files
 * iPodRocks itself wrote and fix them in place, rather than making the user
 * rebuild or re-sync. Everything here is cancellable and streams progress,
 * because a real library is thousands of files.
 */

import { ipcMain } from "electron";

import { safe, getLibrary, getDevicesCore } from "./common";
import { logActivity } from "../activity/activity-logger";
import { repairMpcTagsInTree, type RepairScanResult } from "../tagging/mpc/repair-scan";
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
      const roots: Array<{ label: string; path: string }> = [];

      for (const shadow of lib.getShadowLibraries()) {
        if (shadow.path) {
          roots.push({ label: `Shadow library: ${shadow.name}`, path: shadow.path });
        }
      }

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

      try {
        for (const root of roots) {
          if (signal.aborted) break;

          const result = await repairMpcTagsInTree(root.path, {
            cancelSignal: signal,
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
