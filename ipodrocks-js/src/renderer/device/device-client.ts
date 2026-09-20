/**
 * The browser half of the device link.
 *
 * Holds the picked folder, spins the worker that owns it, and relays RPC
 * frames between that worker and the server's socket. One instance per tab;
 * it can hold several devices at once, because someone may well have two
 * players plugged in.
 *
 * It piggybacks on the transport's existing WebSocket rather than opening its
 * own: a second socket would need its own upgrade, its own `Origin` check and
 * its own authentication, for nothing.
 */
import {
  DEVICE_ATTACH,
  DEVICE_DETACH,
  DEVICE_RPC_REQUEST,
  DEVICE_RPC_RESULT,
  type DeviceAttachFrame,
  type DeviceRpcRequestFrame,
  type DeviceRpcVerb,
} from "@shared/device-rpc";

import { dispatchDeviceRpc } from "./dispatch";
import {
  forgetDeviceHandle,
  hasWritePermission,
  loadDeviceHandle,
  requestWritePermission,
  saveDeviceHandle,
  supportsDirectoryPicker,
} from "./handle-store";

/** What the client needs of the transport: a way to send, and a way to hear. */
export interface DeviceSocket {
  send(frame: unknown): void;
  onFrame(listener: (frame: Record<string, unknown>) => void): () => void;
}

export type DeviceAttachState =
  | { status: "detached" }
  | { status: "attaching" }
  | { status: "attached"; rootName: string; writable: boolean }
  | { status: "error"; message: string };

type StateListener = (deviceId: number, state: DeviceAttachState) => void;

interface Held {
  handle: FileSystemDirectoryHandle;
  worker: Worker | null;
  /** Calls in flight in the worker, so a detach can fail them rather than hang. */
  pending: Map<number, (result: { ok: boolean; value?: unknown; error?: string; code?: string }) => void>;
  nextWorkerId: number;
}

export class DeviceClient {
  private held = new Map<number, Held>();
  private states = new Map<number, DeviceAttachState>();
  private listeners = new Set<StateListener>();
  private offFrame: (() => void) | null = null;

  constructor(private readonly socket: DeviceSocket) {
    this.offFrame = socket.onFrame((frame) => this.onFrame(frame));
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stateOf(deviceId: number): DeviceAttachState {
    return this.states.get(deviceId) ?? { status: "detached" };
  }

  private setState(deviceId: number, state: DeviceAttachState): void {
    this.states.set(deviceId, state);
    for (const l of this.listeners) l(deviceId, state);
  }

  /** Opens the picker. **Must be called straight from a click** — Chrome
   *  rejects a picker that is not inside a user gesture. */
  async pickAndAttach(deviceId: number): Promise<void> {
    if (!supportsDirectoryPicker()) {
      this.setState(deviceId, {
        status: "error",
        message:
          "This browser cannot open a device folder. Connecting a player needs " +
          "the File System Access API, which today means Chrome, Edge or another " +
          "Chromium browser on a desktop.",
      });
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await (
        window as unknown as {
          showDirectoryPicker(o: { mode: "readwrite" }): Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker({ mode: "readwrite" });
    } catch {
      // The user dismissed it. Not an error worth showing.
      return;
    }
    await saveDeviceHandle(deviceId, handle);
    await this.attachHandle(deviceId, handle);
  }

  /**
   * Re-attach a folder picked in an earlier session.
   *
   * Returns false when the handle is gone or its permission has lapsed, which
   * is the normal state after a browser restart — the caller then offers a
   * button, because re-granting needs a gesture.
   */
  async restore(deviceId: number, opts: { prompt?: boolean } = {}): Promise<boolean> {
    const handle = await loadDeviceHandle(deviceId);
    if (!handle) return false;
    let allowed = await hasWritePermission(handle);
    if (!allowed && opts.prompt) allowed = await requestWritePermission(handle);
    if (!allowed) return false;
    await this.attachHandle(deviceId, handle);
    return true;
  }

  /**
   * Attach a directory handle directly.
   *
   * The picker is a user-gesture-gated native dialog no test can drive, but
   * `navigator.storage.getDirectory()` returns a real
   * `FileSystemDirectoryHandle` with the identical interface — so the e2e specs
   * seed an OPFS tree and hand it to this, exercising every line of the File
   * System Access path with no dialog. Only `showDirectoryPicker()` itself is
   * left to manual verification.
   */
  async attachHandle(
    deviceId: number,
    handle: FileSystemDirectoryHandle
  ): Promise<void> {
    this.detachLocal(deviceId);
    this.setState(deviceId, { status: "attaching" });

    const writable = await hasWritePermission(handle);
    const held: Held = {
      handle,
      worker: this.spawnWorker(deviceId, handle),
      pending: new Map(),
      nextWorkerId: 1,
    };
    this.held.set(deviceId, held);

    const frame: DeviceAttachFrame = {
      type: DEVICE_ATTACH,
      deviceId,
      // Read as late as possible: the server subtracts its own clock from this
      // to get the skew it applies to every mtime the device reports.
      clientNow: Date.now(),
      rootName: handle.name,
      writable,
    };
    this.socket.send(frame);
    this.setState(deviceId, { status: "attached", rootName: handle.name, writable });
  }

  /** Gives a device up, and forgets the folder so it is not silently re-used. */
  async disconnect(deviceId: number): Promise<void> {
    this.socket.send({ type: DEVICE_DETACH, deviceId });
    this.detachLocal(deviceId);
    await forgetDeviceHandle(deviceId);
    this.setState(deviceId, { status: "detached" });
  }

  private detachLocal(deviceId: number): void {
    const held = this.held.get(deviceId);
    if (!held) return;
    this.held.delete(deviceId);
    for (const [, settle] of held.pending) {
      settle({ ok: false, error: "The device was disconnected.", code: "EDEVICEDETACHED" });
    }
    held.pending.clear();
    held.worker?.terminate();
  }

  /**
   * Starts the worker, or returns null when workers are unavailable.
   *
   * A null worker is not fatal — {@link runVerb} falls back to running the
   * operation on this thread. That path is slower and blocks the UI, but a
   * sync that is janky beats a sync that cannot happen.
   */
  private spawnWorker(
    deviceId: number,
    handle: FileSystemDirectoryHandle
  ): Worker | null {
    try {
      const worker = new Worker(new URL("./device-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
        const message = event.data;
        if (message.kind !== "result") return;
        const held = this.held.get(deviceId);
        const settle = held?.pending.get(Number(message.id));
        if (!settle) return;
        held!.pending.delete(Number(message.id));
        settle({
          ok: message.ok === true,
          value: message.value,
          error: message.error as string | undefined,
          code: message.code as string | undefined,
        });
      };
      worker.onerror = () => {
        // The worker died. Fall back to the main thread rather than leaving
        // the device wedged.
        const held = this.held.get(deviceId);
        if (held) held.worker = null;
      };
      worker.postMessage({ kind: "init", root: handle });
      return worker;
    } catch {
      return null;
    }
  }

  private runVerb(
    deviceId: number,
    verb: DeviceRpcVerb,
    args: unknown[]
  ): Promise<{ ok: boolean; value?: unknown; error?: string; code?: string }> {
    const held = this.held.get(deviceId);
    if (!held) {
      return Promise.resolve({
        ok: false,
        error: "This tab is not holding that device.",
        code: "EDEVICEDETACHED",
      });
    }

    if (!held.worker) {
      return dispatchDeviceRpc(held.handle, verb, args).then(
        (value) => ({ ok: true, value }),
        (err: Error & { code?: string }) => ({
          ok: false,
          error: err?.message ?? String(err),
          code: err?.code,
        })
      );
    }

    const id = held.nextWorkerId++;
    return new Promise((resolve) => {
      held.pending.set(id, resolve);
      held.worker!.postMessage({ kind: "call", id, verb, args });
    });
  }

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.type === "device-attach-refused") {
      this.setState(Number(frame.deviceId), {
        status: "error",
        message: String(frame.reason ?? "The server refused this device."),
      });
      return;
    }
    if (frame.type !== DEVICE_RPC_REQUEST) return;

    const request = frame as unknown as DeviceRpcRequestFrame;
    void (async () => {
      const result = await this.runVerb(request.deviceId, request.verb, request.args);
      this.socket.send({
        type: DEVICE_RPC_RESULT,
        id: request.id,
        ok: result.ok,
        value: result.value,
        error: result.error,
        code: result.code,
      });
    })();
  }

  close(): void {
    for (const deviceId of [...this.held.keys()]) this.detachLocal(deviceId);
    this.offFrame?.();
    this.offFrame = null;
  }
}
