import type { DeviceTransport } from "./types";

/**
 * Which client can actually drive which device.
 *
 * A device's `transport` says where its filesystem is, and that is not a
 * preference — it is a fact about which machine the player is plugged into:
 *
 * - `local` — plugged into the machine running the sync engine. Only the
 *   desktop app, or a daemon with the player attached to the server itself,
 *   can read or write it.
 * - `web` ("remote") — held by a browser tab through the File System Access
 *   API. Only that tab can reach it; the server has no path to those bytes
 *   except through the tab's RPC.
 *
 * So a web client cannot sync a device on the server's own USB bus, and the
 * desktop window cannot sync a player someone else is holding in a browser.
 * Both cases used to surface as a sync that ran and did nothing useful — or,
 * for a web device seen from Electron, a `DetachedDeviceFs` throw halfway
 * through, which names the filesystem and not the reason.
 *
 * **This lives in `src/shared/` because both sides need the same answer.** The
 * renderer greys the controls out and the main process refuses the operation;
 * a UI that disables a button is a courtesy, not a guard, and a guard the UI
 * disagrees with is a bug report waiting to happen.
 */

/**
 * Why `transport` cannot be operated from this client, or null when it can.
 *
 * The string is shown to the user — on a disabled button's tooltip and in the
 * error a refused handler returns — so it says which machine the player is on
 * rather than naming a transport.
 */
export function deviceLocalityBlock(
  transport: DeviceTransport | undefined,
  clientIsWeb: boolean
): string | null {
  const isRemote = transport === "web";
  if (clientIsWeb && !isRemote) {
    return (
      "This device is plugged into the server, so only the app running there " +
      "can sync it. Add it as a remote device to use it from this browser."
    );
  }
  if (!clientIsWeb && isRemote) {
    return (
      "This is a remote device, held by a browser through the web server. " +
      "Open iPodRocks in that browser to sync it."
    );
  }
  return null;
}

/** A player held by a browser rather than attached to the sync engine's host. */
export function isRemoteDevice(transport: DeviceTransport | undefined): boolean {
  return transport === "web";
}

/**
 * Auto-podcasts are never available on a remote device.
 *
 * The scheduler is a timer in the *server* process: it wakes up, decides a
 * device is due and syncs to it. A remote device exists only while somebody has
 * a tab open holding it, so the schedule would either do nothing at all or —
 * worse — start copying gigabytes through a browser nobody is watching, on a
 * link nobody chose for it. Downloading episodes stays on; only the automatic
 * push to the device is refused.
 */
export function autoPodcastBlock(
  transport: DeviceTransport | undefined
): string | null {
  return isRemoteDevice(transport)
    ? "Auto Podcasts needs a device the server can reach on its own. A remote " +
        "device is only connected while its browser tab is open, so there is " +
        "nothing for the schedule to sync to."
    : null;
}
