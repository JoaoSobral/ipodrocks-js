/**
 * The server half of the device RPC.
 *
 * A browser announces `device-attach` for a device id; from then on this
 * module is registered as that device's {@link DeviceRpcTransport}, and every
 * `RemoteDeviceFs` call made anywhere in `src/main/` becomes a frame on that
 * session's socket.
 *
 * Two things here are load-bearing beyond the plumbing:
 *
 * - **The attachment is checked against the database, not trusted.** A client
 *   says which device id it holds. Without the check any authenticated user
 *   could claim device 1, take over another user's player and receive its
 *   file listings — and, through the data plane, a one-shot URL for any
 *   library file the sync would have sent it.
 * - **The data plane never carries a client-supplied path.** A `pull` token
 *   names a server file *the server chose*, and a `push` token names a server
 *   destination the server chose. The browser is told a URL and a device-side
 *   relative path, never the reverse.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as nodePath from "path";
import type { Request, Response } from "express";

import {
  DEVICE_ATTACH,
  DEVICE_DETACH,
  DEVICE_RPC_REQUEST,
  DEVICE_RPC_RESULT,
  DEVICE_RPC_TIMEOUT_MS,
  type DeviceAttachFrame,
  type DeviceRpcRequestFrame,
  type DeviceRpcResultFrame,
  type DeviceRpcVerb,
} from "../shared/device-rpc";
import {
  registerDeviceTransport,
  type DeviceRpcTransport,
} from "../main/devices/fs/device-transport";
import type { WebSocket } from "ws";
import {
  onSocketClosed,
  registerFrameHandler,
  sendRawToSocket,
} from "./events";

/** What the devices table says about one device id. Injected so this module
 *  does not reach into the library core. */
export interface DeviceAttachRecord {
  transport: "local" | "web";
  /**
   * `"<provider>:<subject>"` of the identity that registered this web device,
   * or null for a local one — and for a web device created before the column
   * existed, which is why null admits rather than refuses.
   */
  webOwnerSubject: string | null;
}

/** Resolves a device id, or null when there is no such device. */
export type DeviceTransportLookup = (deviceId: number) => DeviceAttachRecord | null;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Attachment {
  deviceId: number;
  sessionId: string;
  /**
   * The exact socket that announced the attach — i.e. the tab holding the
   * folder handle, which is finer-grained than the session. See
   * `sendRawToSocket`.
   */
  socket: WebSocket;
  subject: string;
  clockSkewMs: number;
  rootName: string;
  writable: boolean;
  pending: Map<number, Pending>;
  release: () => void;
}

const attachments = new Map<number, Attachment>();

/**
 * Correlation ids, counted once for the whole process rather than per
 * attachment.
 *
 * A result frame carries only its `id`, and one browser tab can hold two
 * players — `restoreWebDevices()` re-opens every web device it remembers. With
 * a per-attachment counter both started at 1, the lookup below matched the
 * first attachment of that session holding that id, so device B's reply
 * resolved device A's call with device B's value and A's real reply then timed
 * out. One counter makes the id unique across every attachment.
 */
let nextRpcId = 1;

/** An error carrying a `code`, so the EPERM/ENOENT branches on the server side
 *  keep working against a device that is really a browser. */
class DeviceRpcError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "DeviceRpcError";
  }
}

// ---------------------------------------------------------- data plane ----

interface IoTokenPayload {
  /** Device the token is for. */
  d: number;
  /** Direction, from the browser's point of view. */
  dir: "pull" | "push";
  /** The server-side absolute path. Never supplied by the client. */
  p: string;
  /** Session the token is bound to. */
  s: string;
  /** Expiry, unix seconds. */
  e: number;
}

/**
 * Rotated per process, like the media key: a token must not outlive the server
 * that issued it, and nothing needs it to.
 */
let ioKey: Buffer | null = null;

export function resetDeviceIoKey(): void {
  ioKey = crypto.randomBytes(32);
}

function signIo(body: string): string {
  if (!ioKey) resetDeviceIoKey();
  return crypto.createHmac("sha256", ioKey as Buffer).update(body).digest("base64url");
}

/**
 * One-shot, in the strong sense: the token is recorded here when issued and
 * removed the first time it is redeemed.
 *
 * The HMAC alone would make a token unforgeable but replayable for its whole
 * lifetime, and these name library files by absolute path. A transfer happens
 * once, so the token is good once.
 *
 * Keyed to its expiry so the map can be swept. A token that is issued and
 * never redeemed — the browser dropped the transfer, the tab closed mid-sync —
 * would otherwise sit here for the life of the process, one entry per file a
 * sync ever attempted.
 */
const liveIoTokens = new Map<string, number>();

const IO_TTL_SECONDS = 6 * 60 * 60;

/** Drops tokens that can no longer be redeemed. Cheap and amortised: it runs
 *  on issue, and a sync issues one token per file. */
function sweepIoTokens(nowSeconds: number): void {
  for (const [token, expiry] of liveIoTokens) {
    if (expiry < nowSeconds) liveIoTokens.delete(token);
  }
}

function issueIoToken(payload: Omit<IoTokenPayload, "e">): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  sweepIoTokens(nowSeconds);
  const expiry = nowSeconds + IO_TTL_SECONDS;
  const body = Buffer.from(
    JSON.stringify({ ...payload, e: expiry }),
    "utf-8"
  ).toString("base64url");
  const token = `${body}.${signIo(body)}`;
  liveIoTokens.set(token, expiry);
  return token;
}

function redeemIoToken(token: string, sessionId: string | null): IoTokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = Buffer.from(signIo(body));
  const presented = Buffer.from(mac);
  if (
    expected.length !== presented.length ||
    !crypto.timingSafeEqual(expected, presented)
  ) {
    return null;
  }
  if (!liveIoTokens.has(token)) return null;

  let payload: IoTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as IoTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.p !== "string" || !payload.p) return null;
  if (typeof payload.e !== "number" || payload.e * 1000 < Date.now()) return null;
  // A token minted for one session is honoured only for that session: the
  // paths inside are library files, and every logged-in identity is not
  // necessarily entitled to every other's transfer.
  if (payload.s !== sessionId) return null;
  // Consumed only once every check has passed. Burning it first meant a
  // request from the wrong session — or one carrying a stale token — spent the
  // single use, and the transfer it was minted for then failed for good.
  liveIoTokens.delete(token);
  return payload;
}

// -------------------------------------------------------------- transport --

function makeTransport(attachment: Attachment): DeviceRpcTransport {
  const send = (verb: DeviceRpcVerb, args: unknown[]): Promise<unknown> => {
    const current = attachments.get(attachment.deviceId);
    if (current !== attachment) {
      return Promise.reject(
        new DeviceRpcError("The browser holding this device disconnected.", "EDEVICEDETACHED")
      );
    }
    const id = nextRpcId++;
    const frame: DeviceRpcRequestFrame = {
      type: DEVICE_RPC_REQUEST,
      id,
      deviceId: attachment.deviceId,
      verb,
      args,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        attachment.pending.delete(id);
        reject(
          new DeviceRpcError(
            `The device did not answer "${verb}" within ${DEVICE_RPC_TIMEOUT_MS / 1000}s.`,
            "ETIMEDOUT"
          )
        );
      }, DEVICE_RPC_TIMEOUT_MS);
      timer.unref?.();
      attachment.pending.set(id, { resolve, reject, timer });
      // Addressed to the tab that attached, not fanned out to the login: only
      // that one has the directory handle.
      if (!sendRawToSocket(attachment.socket, frame)) {
        attachment.pending.delete(id);
        clearTimeout(timer);
        reject(
          new DeviceRpcError("The browser holding this device disconnected.", "EDEVICEDETACHED")
        );
      }
    });
  };

  return {
    get clockSkewMs() {
      return attachment.clockSkewMs;
    },
    get rootName() {
      return attachment.rootName;
    },
    get writable() {
      return attachment.writable;
    },
    async call<T>(verb: DeviceRpcVerb, args: unknown[]): Promise<T> {
      return (await send(verb, args)) as T;
    },
    async pull(localSrc: string, destRel: string): Promise<void> {
      // Fail here rather than handing out a token for a file that is not
      // there: the browser would get a 404 mid-stream and leave a zero-byte
      // track on the device.
      await fsp.access(localSrc, fs.constants.R_OK);
      const token = issueIoToken({
        d: attachment.deviceId,
        dir: "pull",
        p: localSrc,
        s: attachment.sessionId,
      });
      await send("pull", [destRel, `/api/device-io/pull/${token}`]);
    },
    async push(srcRel: string, localDest: string): Promise<void> {
      const token = issueIoToken({
        d: attachment.deviceId,
        dir: "push",
        p: localDest,
        s: attachment.sessionId,
      });
      await send("push", [srcRel, `/api/device-io/push/${token}`]);
    },
  };
}

// ------------------------------------------------------------- lifecycle --

function detach(deviceId: number): void {
  const attachment = attachments.get(deviceId);
  if (!attachment) return;
  attachments.delete(deviceId);
  attachment.release();
  for (const [, pending] of attachment.pending) {
    clearTimeout(pending.timer);
    pending.reject(
      new DeviceRpcError("The browser holding this device disconnected.", "EDEVICEDETACHED")
    );
  }
  attachment.pending.clear();
}

export interface DeviceSessionsOptions {
  lookupTransport: DeviceTransportLookup;
}

export interface DeviceSessions {
  close(): void;
}

export function attachDeviceSessions(opts: DeviceSessionsOptions): DeviceSessions {
  const offAttach = registerFrameHandler(DEVICE_ATTACH, (raw, ctx) => {
    const frame = raw as unknown as DeviceAttachFrame;
    const deviceId = Number(frame.deviceId);
    if (!Number.isInteger(deviceId) || deviceId <= 0) return;

    // The client names the device; the database decides whether that is a
    // thing it may hold. Without this any authenticated session could claim
    // someone else's player and start receiving its listings.
    const record = opts.lookupTransport(deviceId);
    if (record?.transport !== "web") {
      sendRawToSocket(ctx.socket, {
        type: "device-attach-refused",
        deviceId,
        reason: "That device is not a browser-connected device.",
      });
      return;
    }

    // **"It is a web device" is not "it is *your* web device".** Every
    // allowlisted identity satisfies the check above for every web device, so
    // on its own it left `detach()` below — the per-device mutex — working as
    // a takeover primitive: announce someone else's id, evict them, and every
    // later `RemoteDeviceFs` call plus every one-shot data-plane token is
    // addressed to your browser instead. That hands you the library files the
    // sync meant for their player, and lets your folder answer as their
    // device — including the Rockbox index whose ratings are merged back into
    // the shared library.
    //
    // A null owner admits: it means a device registered before the column
    // existed, and inventing an owner for one would strand a player nobody
    // can reconnect. The refusal is deliberate rather than an eviction —
    // taking the device away from its holder is exactly what must not happen.
    if (record.webOwnerSubject !== null && record.webOwnerSubject !== ctx.subject) {
      sendRawToSocket(ctx.socket, {
        type: "device-attach-refused",
        deviceId,
        reason: "That device belongs to a different account.",
      });
      return;
    }

    detach(deviceId);

    const attachment: Attachment = {
      deviceId,
      sessionId: ctx.sessionId,
      subject: ctx.subject,
      // Measured once, here, because this frame is the only moment both clocks
      // are readable within a round trip of each other.
      clockSkewMs: Number(frame.clientNow) - Date.now(),
      rootName: typeof frame.rootName === "string" ? frame.rootName : "device",
      writable: frame.writable !== false,
      socket: ctx.socket,
      pending: new Map(),
      release: () => {},
    };
    attachment.release = registerDeviceTransport(deviceId, makeTransport(attachment));
    attachments.set(deviceId, attachment);

    sendRawToSocket(ctx.socket, { type: "device-attached", deviceId });
  });

  const offDetach = registerFrameHandler(DEVICE_DETACH, (raw, ctx) => {
    const frame = raw as unknown as { deviceId?: number };
    const deviceId = Number(frame.deviceId);
    const attachment = attachments.get(deviceId);
    if (attachment && attachment.socket === ctx.socket) detach(deviceId);
  });

  const offResult = registerFrameHandler(DEVICE_RPC_RESULT, (raw, ctx) => {
    const frame = raw as unknown as DeviceRpcResultFrame;
    for (const attachment of attachments.values()) {
      // Matched on the socket the request went out on, for the same reason it
      // was sent there: a reply can only come from the tab that was asked.
      if (attachment.socket !== ctx.socket) continue;
      const pending = attachment.pending.get(Number(frame.id));
      if (!pending) continue;
      attachment.pending.delete(Number(frame.id));
      clearTimeout(pending.timer);
      if (frame.ok) pending.resolve(frame.value);
      else pending.reject(new DeviceRpcError(frame.error ?? "Device error", frame.code));
      return;
    }
  });

  // A tab that goes away takes its devices with it. Without this the device
  // still looks attached, and the first sync after the tab closed waits two
  // minutes per call before failing.
  const offClosed = onSocketClosed((_sessionId, socket) => {
    // Per socket, not per session: closing one of two tabs must not take the
    // other tab's device down with it.
    for (const [deviceId, attachment] of [...attachments]) {
      if (attachment.socket === socket) detach(deviceId);
    }
  });

  return {
    close(): void {
      offAttach();
      offDetach();
      offResult();
      offClosed();
      for (const deviceId of [...attachments.keys()]) detach(deviceId);
      liveIoTokens.clear();
    },
  };
}

/** Which devices a browser is holding right now. The Devices panel asks so it
 *  can show a web device as connected. */
export function attachedDeviceIds(): number[] {
  return [...attachments.keys()];
}

/** Tests, and a server restart. */
export function resetDeviceSessions(): void {
  for (const deviceId of [...attachments.keys()]) detach(deviceId);
  liveIoTokens.clear();
  resetDeviceIoKey();
}

// ------------------------------------------------------------ http routes --

/**
 * `GET /api/device-io/pull/:token` — the browser fetching a file to write onto
 * the device, and `POST /api/device-io/push/:token` — the browser handing a
 * device file back.
 *
 * Deliberately plain HTTP rather than socket frames: a track is megabytes, and
 * framing it would buffer it twice with no backpressure. The path comes out of
 * the signed token, never off the request.
 */
export async function handleDeviceIo(req: Request, res: Response): Promise<void> {
  const direction = req.params.direction === "push" ? "push" : "pull";
  const token = String(req.params.token ?? "");
  const sessionId = (req as Request & { sessionID?: string }).sessionID ?? null;

  const payload = redeemIoToken(token, sessionId);
  if (!payload || payload.dir !== direction) {
    res.status(403).type("text/plain").send("Forbidden");
    return;
  }

  if (direction === "pull") {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(payload.p);
    } catch {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(payload.p);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return;
  }

  await fsp.mkdir(nodePath.dirname(payload.p), { recursive: true });
  const out = fs.createWriteStream(payload.p);
  await new Promise<void>((resolve, reject) => {
    req.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    req.on("error", reject);
  }).catch(() => {
    res.status(500).type("text/plain").send("Write failed");
  });
  if (!res.headersSent) res.status(204).end();
}
