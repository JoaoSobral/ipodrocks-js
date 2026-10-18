import type { DeviceConnection, DeviceTransport } from "./types";

/**
 * What the guards need to know about a device: a bare transport (older
 * callers, and the renderer's form state), or the profile itself, whose
 * `remoteEnabled` makes a local device hybrid.
 */
export type DeviceReach =
  | DeviceTransport
  | { transport?: DeviceTransport; remoteEnabled?: boolean | null }
  | null
  | undefined;

/** Which machines can reach this device. */
export function deviceConnection(device: DeviceReach): DeviceConnection {
  const transport = typeof device === "string" ? device : device?.transport;
  if (transport === "web") return "remote";
  const remoteEnabled = typeof device === "object" && device !== null && device.remoteEnabled === true;
  return remoteEnabled ? "hybrid" : "local";
}

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
  device: DeviceReach,
  clientIsWeb: boolean
): string | null {
  const connection = deviceConnection(device);
  // Each side of a hybrid device is reachable from its own client.
  if (connection === "hybrid") return null;
  const isRemote = connection === "remote";
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

/**
 * Why this client may not *edit or delete* the device, or null.
 *
 * Deliberately narrower than `deviceLocalityBlock()`, and asymmetric, because
 * the two directions are not the same relationship:
 *
 * - **The desktop app may remove a remote device.** It is the machine that
 *   holds the database; somebody has to be able to tidy up a device whose
 *   browser is never coming back, and refusing would strand the row forever.
 * - **A browser may not touch a server-attached device's settings at all.**
 *   That configuration belongs to the machine the player is plugged into —
 *   its mount path, its USB identity, its folder layout are all facts about
 *   *there* — and a remote client editing or deleting it is changing something
 *   it cannot see and will never be able to verify.
 */
export function deviceAdminBlock(
  device: DeviceReach,
  clientIsWeb: boolean,
  op: "edit" | "remove" = "edit"
): string | null {
  const connection = deviceConnection(device);
  // A browser holding a hybrid device may change its ordinary settings (the
  // handler keeps the mount path and USB identity out of reach), but the
  // device is also the server's: removing it is for the app running there.
  // The browser can give up its own connection instead.
  if (clientIsWeb && connection === "hybrid") {
    return op === "remove"
      ? "This device is also plugged into the server. Remove it from the app " +
          "running there, or stop using it from this browser in its Connections."
      : null;
  }
  if (clientIsWeb && connection === "local") {
    return (
      "This device belongs to the machine running the server. Change or remove " +
      "it from the app running there."
    );
  }
  return null;
}

/** A device held by a browser rather than attached to the sync engine's host. */
export function isRemoteDevice(device: DeviceReach): boolean {
  return deviceConnection(device) === "remote";
}

/** A browser may hold this device (remote or hybrid). */
export function browserMayHold(device: DeviceReach): boolean {
  return deviceConnection(device) !== "local";
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
export function autoPodcastBlock(device: DeviceReach): string | null {
  // A hybrid device is fine: the schedule reaches it through its local mount.
  return isRemoteDevice(device)
    ? "Auto Podcasts needs a device the server can reach on its own. A remote " +
        "device is only connected while its browser tab is open, so there is " +
        "nothing for the schedule to sync to."
    : null;
}
