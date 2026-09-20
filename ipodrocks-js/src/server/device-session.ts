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
import {
  onSocketClosed,
  registerFrameHandler,
  sendRawToSession,
} from "./events";

/** Resolves a device id to its stored transport, or null when there is no such
 *  device. Injected so this module does not reach into the library core. */
export type DeviceTransportLookup = (deviceId: number) => "local" | "web" | null;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Attachment {
  deviceId: number;
  sessionId: string;
  subject: string;
  clockSkewMs: number;
  rootName: string;
  writable: boolean;
  nextId: number;
  pending: Map<number, Pending>;
  release: () => void;
}

const attachments = new Map<number, Attachment>();

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
 */
const liveIoTokens = new Set<string>();

const IO_TTL_SECONDS = 6 * 60 * 60;

function issueIoToken(payload: Omit<IoTokenPayload, "e">): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, e: Math.floor(Date.now() / 1000) + IO_TTL_SECONDS }),
    "utf-8"
  ).toString("base64url");
  const token = `${body}.${signIo(body)}`;
  liveIoTokens.add(token);
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
  if (!liveIoTokens.delete(token)) return null;

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
    const id = attachment.nextId++;
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
      if (!sendRawToSession(attachment.sessionId, frame)) {
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
    if (opts.lookupTransport(deviceId) !== "web") {
      sendRawToSession(ctx.sessionId, {
        type: "device-attach-refused",
        deviceId,
        reason: "That device is not a browser-connected device.",
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
      nextId: 1,
      pending: new Map(),
      release: () => {},
    };
    attachment.release = registerDeviceTransport(deviceId, makeTransport(attachment));
    attachments.set(deviceId, attachment);

    sendRawToSession(ctx.sessionId, { type: "device-attached", deviceId });
  });

  const offDetach = registerFrameHandler(DEVICE_DETACH, (raw, ctx) => {
    const frame = raw as unknown as { deviceId?: number };
    const deviceId = Number(frame.deviceId);
    const attachment = attachments.get(deviceId);
    if (attachment && attachment.sessionId === ctx.sessionId) detach(deviceId);
  });

  const offResult = registerFrameHandler(DEVICE_RPC_RESULT, (raw, ctx) => {
    const frame = raw as unknown as DeviceRpcResultFrame;
    for (const attachment of attachments.values()) {
      if (attachment.sessionId !== ctx.sessionId) continue;
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
  const offClosed = onSocketClosed((sessionId) => {
    for (const [deviceId, attachment] of [...attachments]) {
      if (attachment.sessionId === sessionId) detach(deviceId);
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
