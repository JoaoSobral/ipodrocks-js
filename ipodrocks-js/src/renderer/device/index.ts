/**
 * The tab's single device link.
 *
 * Exists only in web mode: in the desktop app the device is a folder on the
 * same machine and `NodeDeviceFs` reaches it directly, with no browser in the
 * path at all.
 */
import { getWebTransport } from "@renderer/ipc/web-transport";

import { DeviceClient, type DeviceAttachState, type DeviceSocket } from "./device-client";

export type { DeviceAttachState };
export { supportsDirectoryPicker } from "./handle-store";

let client: DeviceClient | null = null;
/** Devices this tab has attached, so a reconnect can re-announce them. */
const attached = new Set<number>();

/**
 * The device link, reachable from the page.
 *
 * `showDirectoryPicker()` is a user-gesture-gated native dialog Playwright
 * cannot drive, so the e2e specs seed an OPFS tree — a real
 * `FileSystemDirectoryHandle` with the identical interface — and hand it to
 * `attachHandle()`. Exposing the client is what makes that possible without a
 * second, test-only code path through the File System Access layer, which
 * would test itself rather than the thing that ships.
 *
 * It carries no capability a logged-in user does not already have: everything
 * on it needs a folder handle the browser only grants through the picker.
 */
function publish(instance: DeviceClient): void {
  (window as unknown as { __ipodrocksDevice?: DeviceClient }).__ipodrocksDevice =
    instance;
}

export function getDeviceClient(): DeviceClient | null {
  if (client) return client;
  const transport = getWebTransport();
  if (!transport) return null;

  const socket: DeviceSocket = {
    send: (frame) => transport.sendFrame(frame),
    onFrame: (listener) => transport.onFrame(listener),
  };
  client = new DeviceClient(socket);

  // A dropped socket leaves the server with no attachment for this device, and
  // nothing tells the user — the next sync simply reports the player as not
  // connected. Re-announcing on every reopen makes a tunnel blip or a laptop
  // sleep invisible, which is what it should be.
  transport.onReopen(() => {
    for (const deviceId of attached) {
      void client?.restore(deviceId).catch(() => {});
    }
  });

  client.onStateChange((deviceId, state) => {
    if (state.status === "attached") attached.add(deviceId);
    else if (state.status === "detached") attached.delete(deviceId);
  });

  publish(client);
  return client;
}

/**
 * Re-open the folders this browser picked before, without prompting.
 *
 * Called once when the app mounts. A handle whose permission has lapsed is
 * skipped silently: re-granting needs a user gesture, so the Devices panel
 * offers a button instead of the app throwing a dialog at someone who just
 * opened a tab.
 */
export async function restoreWebDevices(deviceIds: number[]): Promise<void> {
  const c = getDeviceClient();
  if (!c) return;
  for (const deviceId of deviceIds) {
    try {
      await c.restore(deviceId);
    } catch {
      /* the panel shows it as disconnected, which it is */
    }
  }
}
