/**
 * The device worker.
 *
 * A sync walks thousands of files and streams gigabytes through the File
 * System Access API. Doing that on the UI thread makes the whole app
 * unresponsive for the length of the sync — and the sync is exactly when the
 * user is watching the progress bar. So the directory handle lives here, and
 * the main thread only relays frames.
 *
 * Handles are structured-cloneable, which is what makes this possible at all:
 * the handle is posted in once and never crosses again.
 */
import type { DeviceRpcVerb } from "@shared/device-rpc";

import { dispatchDeviceRpc } from "./dispatch";

interface InitMessage {
  kind: "init";
  root: FileSystemDirectoryHandle;
}

interface CallMessage {
  kind: "call";
  id: number;
  verb: DeviceRpcVerb;
  args: unknown[];
}

type Incoming = InitMessage | CallMessage;

let root: FileSystemDirectoryHandle | null = null;

self.onmessage = (event: MessageEvent<Incoming>): void => {
  const message = event.data;

  if (message.kind === "init") {
    root = message.root;
    self.postMessage({ kind: "ready" });
    return;
  }

  if (message.kind !== "call") return;

  void (async () => {
    if (!root) {
      self.postMessage({
        kind: "result",
        id: message.id,
        ok: false,
        error: "The device folder is not open in this tab.",
        code: "EDEVICEDETACHED",
      });
      return;
    }
    try {
      const value = await dispatchDeviceRpc(root, message.verb, message.args);
      self.postMessage({ kind: "result", id: message.id, ok: true, value });
    } catch (err) {
      self.postMessage({
        kind: "result",
        id: message.id,
        ok: false,
        error: (err as Error)?.message ?? String(err),
        code: (err as { code?: string })?.code,
      });
    }
  })();
};
