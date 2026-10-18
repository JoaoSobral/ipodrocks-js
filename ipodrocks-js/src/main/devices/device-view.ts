/**
 * A hybrid device as one client sees it.
 *
 * A hybrid device (`transport: "local"` + `remoteEnabled`) is one row with two
 * ways in: its real mount on the machine running the sync engine, and a folder
 * a browser holds under the synthetic `webDeviceRoot(id)`. Everything below a
 * handler — the sync, the device check, the runtime read and rating write, the
 * Rockbox database build, `effectiveParallelCopies` — already branches on
 * `profile.transport` and `mountPath`. So rather than teach each of them about
 * a third kind, a handler resolves the device for its caller here and hands
 * down a device that *is* local or remote for the length of the call:
 *
 * - the desktop app or the daemon (no session) gets the local side unchanged;
 * - a browser gets `transport: "web"`, `mountPath: webDeviceRoot(id)` and the
 *   `RemoteDeviceFs` (or `DetachedDeviceFs`) that goes with it.
 *
 * **Every handler that operates on a device it looked up must go through this**
 * (or `deviceForCaller()` in the assistant tools). One that does not would
 * hand a browser's sync the server's mount path — and `NodeDeviceFs` — which
 * is exactly the "sync ran against the wrong filesystem" failure the locality
 * guards exist to prevent.
 *
 * Everything the two sides share is keyed on the device id and mount-relative
 * paths (`device_synced_tracks.device_path`, the rating baselines, the sync
 * preferences), so a sync from either side sees the other's work.
 */
import type { DeviceProfile } from "../../shared/types";
import { Device } from "./device";
import { webDeviceRoot } from "./fs/device-fs";

export function deviceForClient(device: Device, clientIsWeb: boolean): Device {
  if (device.profile.connection !== "hybrid") return device;
  if (!clientIsWeb) {
    // Already the local side; pin `connection` so nothing below re-derives a
    // browser view from it.
    return new Device({ ...device.profile, connection: "local" }, device.fs);
  }
  const view: DeviceProfile = {
    ...device.profile,
    transport: "web",
    mountPath: webDeviceRoot(device.profile.id),
    connection: "remote",
  };
  return new Device(view);
}
