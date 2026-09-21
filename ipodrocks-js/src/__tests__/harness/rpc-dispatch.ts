/**
 * The browser's device dispatcher, callable from Node.
 *
 * `src/renderer/device/dispatch.ts` is the real thing and is what a browser
 * runs; it is imported here rather than re-implemented, because a test against
 * a second copy of the logic would pass while the shipped one was wrong — the
 * exact mistake `behaviors/rating-writeback.test.ts` made before issue #138.
 *
 * Two globals it expects are not in Node's vitest environment: `btoa`/`atob`
 * for the base64 hop, and `fetch` for the data plane. The first two are
 * provided; the data plane is never exercised through here, because moving a
 * whole file is the one thing that does not go over this path.
 */
import type { DeviceRpcVerb } from "../../shared/device-rpc";
import { dispatchDeviceRpc } from "../../renderer/device/dispatch";

const globals = globalThis as unknown as {
  btoa?: (s: string) => string;
  atob?: (s: string) => string;
};

if (!globals.btoa) {
  globals.btoa = (s: string) => Buffer.from(s, "binary").toString("base64");
}
if (!globals.atob) {
  globals.atob = (s: string) => Buffer.from(s, "base64").toString("binary");
}

export async function dispatchLocalRpc(
  root: FileSystemDirectoryHandle,
  verb: DeviceRpcVerb,
  args: unknown[]
): Promise<unknown> {
  return dispatchDeviceRpc(root, verb, args);
}
