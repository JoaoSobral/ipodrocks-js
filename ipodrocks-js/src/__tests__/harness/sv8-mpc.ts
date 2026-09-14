/**
 * Fixtures for the Musepack SV8 stream header (issue #137), shared by the unit,
 * regression and e2e specs that need one.
 *
 * The packets are hand-assembled from a hexdump of a file `mpcenc 1.30.1`
 * actually produced — the version the app shells out to — rather than written
 * by our own encoder. Two reasons, and both of them are the lesson of #125:
 * a round trip through our own code is not a format test, and there is no
 * library here to check it against either — music-metadata parses SV8 but
 * skips the `RG` packet outright (`MpcSv8Parser.js`: `case 'RG': … ignore`).
 *
 * The real head, verbatim:
 *
 * ```
 * 4d50 434b 5348 0e2b be1f 4f08 85b1 0800  MPCKSH.+..O.....
 * 1b1b 5247 0c01 0000 0000 0000 0000 4549  ..RG..........EI
 * ```
 */
import * as fs from "fs";
import * as path from "path";

import { COVER } from "./legacy-mpc";

/** The `SH` packet mpcenc emits: key, size 14, then 11 bytes of stream header. */
export const MPCENC_SH_PACKET = Buffer.from([
  0x53, 0x48, 0x0e, 0x2b, 0xbe, 0x1f, 0x4f, 0x08, 0x85, 0xb1, 0x08, 0x00, 0x1b, 0x1b,
]);

/** The `EI` (encoder info) packet mpcenc emits, used to displace `RG`. */
export const MPCENC_EI_PACKET = Buffer.from([0x45, 0x49, 0x07, 0xa0, 0x01, 0x1e, 0x01]);

export interface Sv8ReplayGainFields {
  trackGain?: number;
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
}

export interface Sv8FixtureOptions {
  /** The stored `RG` fields. `null` omits the packet entirely. Default: zeros. */
  rg?: Sv8ReplayGainFields | null;
  /** Payload version byte, for the "a version we don't know" refusal. */
  rgVersion?: number;
  /** Wedge an `EI` packet between `SH` and `RG` (Rockbox would never find it). */
  rgAfterEi?: boolean;
  /** Pad `SH` so the packet lands outside Rockbox's 32-byte window. */
  oversizedSh?: boolean;
  /** APEv2 text items to append, in order. */
  ape?: Record<string, string>;
  /** Append a legacy mis-flagged cover item (flags = 1) after the text items. */
  cover?: boolean;
}

function rgPacket(fields: Sv8ReplayGainFields, version: number): Buffer {
  const payload = Buffer.alloc(9);
  payload[0] = version;
  payload.writeInt16BE(fields.trackGain ?? 0, 1);
  payload.writeUInt16BE(fields.trackPeak ?? 0, 3);
  payload.writeInt16BE(fields.albumGain ?? 0, 5);
  payload.writeUInt16BE(fields.albumPeak ?? 0, 7);
  return Buffer.concat([Buffer.from("RG", "ascii"), Buffer.from([2 + 1 + 9]), payload]);
}

/** An `SH` packet padded to `size` bytes, so `RG` starts further in. */
function oversizedShPacket(size: number): Buffer {
  const body = Buffer.alloc(size - 3, 0x5a);
  MPCENC_SH_PACKET.subarray(3).copy(body, 0);
  return Buffer.concat([Buffer.from("SH", "ascii"), Buffer.from([size]), body]);
}

function packet(key: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(key, "ascii"),
    Buffer.from([2 + 1 + payload.byteLength]),
    payload,
  ]);
}

/** APEv2 pieces, hand-rolled for the same reason as `legacy-mpc.ts`'s. */
function textItem(key: string, value: string): Buffer {
  const val = Buffer.from(value, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(0, 4); // UTF-8 text
  return Buffer.concat([head, Buffer.from(key, "ascii"), Buffer.alloc(1, 0), val]);
}

/** The cover item exactly as the pre-2.3.2 writer emitted it: flags = 1. */
function legacyCoverItem(): Buffer {
  const val = Buffer.concat([Buffer.from("cover.jpg", "utf8"), Buffer.alloc(1, 0), COVER]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(1, 4);
  return Buffer.concat([
    head,
    Buffer.from("Cover Art (Front)", "ascii"),
    Buffer.alloc(1, 0),
    val,
  ]);
}

function apeBlock(items: Buffer[]): Buffer {
  const body = Buffer.concat(items);
  const tagSize = body.byteLength + 32;
  const head = (isHeader: boolean): Buffer => {
    const buf = Buffer.alloc(32, 0);
    buf.write("APETAGEX", 0, "ascii");
    buf.writeUInt32LE(2000, 8);
    buf.writeUInt32LE(tagSize, 12);
    buf.writeUInt32LE(items.length, 16);
    let flags = (1 << 31) | (1 << 30);
    if (isHeader) flags |= 1 << 29;
    buf.writeUInt32LE(flags >>> 0, 20);
    return buf;
  };
  return Buffer.concat([head(true), body, head(false)]);
}

/** A plausible SV8 Musepack file: `MPCK SH [EI] RG AP SE` plus an APEv2 tag. */
export function buildSv8Mpc(options: Sv8FixtureOptions = {}): Buffer {
  const { rg = {}, rgVersion = 1, rgAfterEi = false, oversizedSh = false } = options;

  const parts: Buffer[] = [Buffer.from("MPCK", "ascii")];
  parts.push(oversizedSh ? oversizedShPacket(30) : MPCENC_SH_PACKET);
  if (rgAfterEi) parts.push(MPCENC_EI_PACKET);
  if (rg !== null) parts.push(rgPacket(rg, rgVersion));
  if (!rgAfterEi) parts.push(MPCENC_EI_PACKET);
  parts.push(packet("AP", Buffer.alloc(64, 0xa5)));
  parts.push(packet("SE", Buffer.alloc(0)));

  const items = Object.entries(options.ape ?? {}).map(([k, v]) => textItem(k, v));
  if (options.cover) items.push(legacyCoverItem());
  if (items.length > 0) parts.push(apeBlock(items));

  return Buffer.concat(parts);
}

export function writeSv8Mpc(filePath: string, options: Sv8FixtureOptions = {}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildSv8Mpc(options));
}

/** Decode the four stored words straight out of a file's bytes. */
export function readRawReplayGain(file: Buffer, payloadStart = 21): Sv8ReplayGainFields {
  return {
    trackGain: file.readInt16BE(payloadStart + 1),
    trackPeak: file.readUInt16BE(payloadStart + 3),
    albumGain: file.readInt16BE(payloadStart + 5),
    albumPeak: file.readUInt16BE(payloadStart + 7),
  };
}
