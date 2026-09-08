/**
 * Fixtures for the pre-2.3.2 Musepack tag defect (issue #125), shared by every
 * spec that needs a file carrying it — unit, behaviour and e2e alike.
 *
 * The bytes are hand-assembled rather than produced by the app's own writer on
 * purpose: the writer has been fixed, so it can no longer emit the shape these
 * tests exist to repair. Building the block by hand is also what keeps this a
 * format test rather than a round trip through our own code — the mistake that
 * let #125 ship in the first place.
 */
import * as fs from "fs";
import * as path from "path";

/** "MP+" SV7 magic plus filler, so the file is a plausible Musepack. */
export const AUDIO = Buffer.concat([
  Buffer.from([0x4d, 0x50, 0x2b, 0x07]),
  Buffer.alloc(2048, 0xa5),
]);

/** JPEG-ish, riddled with the NUL bytes that made one item read as thousands. */
export const COVER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(96, 0x00),
  Buffer.from([0x11, 0x22, 0x00, 0x33]),
]);

function textItem(key: string, value: string): Buffer {
  const val = Buffer.from(value, "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(0, 4); // UTF-8 text
  return Buffer.concat([head, Buffer.from(key, "ascii"), Buffer.alloc(1, 0), val]);
}

/** The cover item exactly as the buggy writer emitted it: flags = 1. */
function legacyCoverItem(): Buffer {
  const val = Buffer.concat([Buffer.from("cover.jpg", "utf8"), Buffer.alloc(1, 0), COVER]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(val.byteLength, 0);
  head.writeUInt32LE(1, 4); // <- the defect: read-only TEXT, not binary
  return Buffer.concat([
    head,
    Buffer.from("Cover Art (Front)", "ascii"),
    Buffer.alloc(1, 0),
    val,
  ]);
}

/** Write an .mpc with the pre-fix tag: artwork ahead of the ReplayGain items. */
export function writeLegacyMpc(filePath: string): void {
  const items = [
    textItem("Title", "Legacy Track"),
    legacyCoverItem(),
    textItem("REPLAYGAIN_TRACK_GAIN", "-3.38 dB"),
    textItem("REPLAYGAIN_ALBUM_GAIN", "-4.10 dB"),
  ];
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

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([AUDIO, head(true), body, head(false)]));
}

/** The flags word preceding an APEv2 item's key. */
export function itemFlags(file: Buffer, key: string): number {
  return file.readUInt32LE(itemOffset(file, key) - 4);
}

/** Byte offset of an APEv2 item's key within the file. */
export function itemOffset(file: Buffer, key: string): number {
  const at = file.indexOf(Buffer.from(`${key}\0`, "ascii"));
  if (at < 0) throw new Error(`item "${key}" not found`);
  return at;
}
