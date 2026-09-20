/**
 * The device filesystem boundary.
 *
 * `createDeviceFs` is the single place that decides which implementation a
 * device gets. Nothing else should construct one: a `new NodeDeviceFs(...)`
 * elsewhere is how a browser-held device ends up being written to the server's
 * own disk.
 *
 * The one deliberate exception is a *local root that is not a device* — the
 * shadow library — which builds its own `NodeDeviceFs` explicitly so the two
 * can never be confused for one another.
 */
import type { DeviceProfile } from "../../../shared/types";

import type { DeviceFs } from "./device-fs";
import { NodeDeviceFs } from "./node-device-fs";

export * from "./device-fs";
export { NodeDeviceFs } from "./node-device-fs";

export function createDeviceFs(profile: DeviceProfile): DeviceFs {
  return new NodeDeviceFs(profile.mountPath ?? "");
}

/**
 * A `DeviceFs` over a plain local directory that is not a device.
 *
 * Used by the shadow-library build, which writes transcodes and artwork to a
 * folder on the machine running the sync. Named apart from `createDeviceFs` so
 * the reader of a call site can tell at a glance which side of the wire it is
 * on.
 */
export function localFs(root: string): DeviceFs {
  return new NodeDeviceFs(root);
}

/**
 * A `DeviceFs` for a device known only by its mount path.
 *
 * The auto-podcast and auto-audiobook syncs deliberately work off a narrow
 * `devices` row rather than a full profile, so they cannot call
 * {@link createDeviceFs}. This is the fallback they use when no caller hands
 * them the real one — and in web mode that row's `mount_path` is the synthetic
 * web root, which `NodeDeviceFs` refuses outright, so a missed hand-down fails
 * loudly instead of writing to the server's own disk.
 */
export function deviceFsForMountPath(mountPath: string): DeviceFs {
  return new NodeDeviceFs(mountPath);
}
