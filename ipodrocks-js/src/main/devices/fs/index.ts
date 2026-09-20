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
import { RemoteDeviceFs } from "./remote-device-fs";
import { DeviceDetachedError, getDeviceTransport } from "./device-transport";

export * from "./device-fs";
export * from "./device-transport";
export { NodeDeviceFs } from "./node-device-fs";
export { RemoteDeviceFs } from "./remote-device-fs";

/**
 * The filesystem a device's files live on.
 *
 * A `web` device with no browser attached gets {@link DetachedDeviceFs} rather
 * than a `NodeDeviceFs`: falling back to the local filesystem would be read as
 * "the device is empty", and a mirror sync against an empty device copies the
 * entire library into a directory tree on the server.
 */
export function createDeviceFs(profile: DeviceProfile): DeviceFs {
  if (profile.transport === "web") {
    const transport = getDeviceTransport(profile.id);
    if (!transport) return new DetachedDeviceFs(profile.id, profile.mountPath ?? "");
    return new RemoteDeviceFs(profile.mountPath ?? "", transport);
  }
  return new NodeDeviceFs(profile.mountPath ?? "");
}

/**
 * A web device whose browser is not connected.
 *
 * Every call throws {@link DeviceDetachedError}. The alternative — answering
 * "not found" — is far worse than an error: a mirror sync reads an empty
 * device as "every track is missing" and starts copying the library, and an
 * orphan sweep reads it as "nothing here to keep".
 */
export class DetachedDeviceFs implements DeviceFs {
  readonly capabilities = { setMtime: false, freeSpace: false, eject: false };

  constructor(private readonly deviceId: number, readonly root: string) {}

  private fail(): never {
    throw new DeviceDetachedError(this.deviceId);
  }

  async exists(): Promise<boolean> {
    this.fail();
  }
  async stat(): Promise<never> {
    this.fail();
  }
  async readdir(): Promise<never> {
    this.fail();
  }
  async listTree(): Promise<never> {
    this.fail();
  }
  async readFile(): Promise<never> {
    this.fail();
  }
  async readRange(): Promise<never> {
    this.fail();
  }
  async writeFile(): Promise<never> {
    this.fail();
  }
  async patch(): Promise<never> {
    this.fail();
  }
  async copyFromLocal(): Promise<never> {
    this.fail();
  }
  async mkdir(): Promise<never> {
    this.fail();
  }
  async unlink(): Promise<never> {
    this.fail();
  }
  async rmdir(): Promise<never> {
    this.fail();
  }
  async rm(): Promise<never> {
    this.fail();
  }
  async rename(): Promise<never> {
    this.fail();
  }
  async setMtime(): Promise<never> {
    this.fail();
  }
  async freeSpace(): Promise<null> {
    return null;
  }
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
