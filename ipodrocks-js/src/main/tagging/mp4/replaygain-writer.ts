/**
 * Append ReplayGain values as iTunes-style `----` freeform atoms into an MP4
 * (`.m4a`) file's `moov > udta > meta > ilst`, since ffmpeg's own MOV/MP4
 * muxer silently drops any metadata key it doesn't recognize as a standard
 * atom (confirmed empirically: even an explicit `-metadata:s:a:0
 * REPLAYGAIN_TRACK_GAIN=...` is dropped on encode).
 *
 * Rockbox's `mp4.c` reads only the `name` atom's content as the tag key
 * (case-insensitively) and never looks at `mean` — but `mean` is still set to
 * the conventional `"com.apple.iTunes"` for compatibility with other tools
 * (iTunes, Music.app, mp4v2-based taggers).
 *
 * Safety: this only ever APPENDS to a `moov` box that sits after every
 * top-level `mdat`. Sample tables (`stco`/`co64`) store absolute byte offsets
 * into `mdat`; as long as `mdat` itself is untouched and `moov` is the last
 * top-level box, growing `moov` cannot invalidate any offset. If a future
 * ffmpeg build/flag (e.g. `-movflags +faststart`) ever puts `moov` before
 * `mdat`, this refuses to touch the file rather than risk producing a file
 * with sample offsets that no longer point at the right bytes.
 */
import * as fs from "fs";

interface BoxLoc {
  type: string;
  start: number;
  end: number;
}

function readBoxSize(buf: Buffer, pos: number): number | null {
  if (pos + 8 > buf.length) return null;
  const size = buf.readUInt32BE(pos);
  if (size === 1) return null; // 64-bit extended size: not produced by our encoders, unsupported here.
  return size;
}

/** List the immediate child boxes in `[start, end)`. Stops at the first malformed box. */
function listChildren(buf: Buffer, start: number, end: number): BoxLoc[] {
  const boxes: BoxLoc[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = readBoxSize(buf, pos);
    if (size == null) break;
    const boxEnd = pos + (size === 0 ? end - pos : size);
    if (size < 8 || boxEnd > end) break;
    boxes.push({ type: buf.toString("ascii", pos + 4, pos + 8), start: pos, end: boxEnd });
    pos = boxEnd;
  }
  return boxes;
}

function findChild(children: BoxLoc[], type: string): BoxLoc | undefined {
  return children.find((b) => b.type === type);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32be(payload.length + 8), Buffer.from(type, "ascii"), payload]);
}

const HDLR_ATOM = box(
  "hdlr",
  Buffer.concat([
    u32be(0), // version + flags
    u32be(0), // predefined
    Buffer.from("mdir", "ascii"), // handler_type
    Buffer.from("appl", "ascii"), // manufacturer (component_manufacturer)
    u32be(0), // reserved
    u32be(0), // reserved
    Buffer.from([0]), // empty pascal-string component name
  ])
);

function buildDataAtom(value: string): Buffer {
  const payload = Buffer.concat([
    u32be(1), // version(0) + flags(1 = UTF-8 text), packed as one 32-bit field
    u32be(0), // locale/reserved
    Buffer.from(value, "utf8"),
  ]);
  return box("data", payload);
}

function buildMeanOrNameAtom(type: "mean" | "name", value: string): Buffer {
  return box(type, Buffer.concat([u32be(0), Buffer.from(value, "utf8")]));
}

function buildFreeformAtom(name: string, value: string): Buffer {
  return box(
    "----",
    Buffer.concat([
      buildMeanOrNameAtom("mean", "com.apple.iTunes"),
      buildMeanOrNameAtom("name", name),
      buildDataAtom(value),
    ])
  );
}

/**
 * Replace the first child of `type` in `children` with `replacement`, or
 * append `replacement` if no child of that type exists.
 */
function replaceOrAppendChild(
  buf: Buffer,
  children: BoxLoc[],
  type: string,
  replacement: Buffer
): Buffer {
  const parts: Buffer[] = [];
  let replaced = false;
  for (const child of children) {
    if (child.type === type) {
      parts.push(replacement);
      replaced = true;
    } else {
      parts.push(buf.subarray(child.start, child.end));
    }
  }
  if (!replaced) parts.push(replacement);
  return Buffer.concat(parts);
}

/**
 * Append `tags` (already-lowercased freeform names, e.g.
 * `"replaygain_track_gain"`, mapped to values already formatted the way
 * Rockbox expects, e.g. `"-3.38 dB"`) into `filePath`'s `moov > udta > meta >
 * ilst`. Returns `false` (and leaves the file untouched) when there is
 * nothing to write, the file can't be read, or `moov` doesn't safely sit
 * after every `mdat` — never partially writes a file.
 */
export function writeM4aReplayGainTags(filePath: string, tags: Record<string, string>): boolean {
  const keys = Object.keys(tags);
  if (keys.length === 0) return false;

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return false;
  }

  const top = listChildren(buf, 0, buf.length);
  const moov = findChild(top, "moov");
  const mdatBoxes = top.filter((b) => b.type === "mdat");
  if (!moov || mdatBoxes.length === 0) return false;
  if (Math.max(...mdatBoxes.map((b) => b.end)) > moov.start) return false;

  const moovChildren = listChildren(buf, moov.start + 8, moov.end);
  const udta = findChild(moovChildren, "udta");
  const udtaChildren = udta ? listChildren(buf, udta.start + 8, udta.end) : [];
  const meta = findChild(udtaChildren, "meta");
  // `meta` is a full box: 4 bytes of version+flags precede its children.
  const metaChildren = meta ? listChildren(buf, meta.start + 12, meta.end) : [];
  const metaVersionFlags = meta ? buf.subarray(meta.start + 8, meta.start + 12) : u32be(0);
  const hdlrAtom = findChild(metaChildren, "hdlr");
  const ilstAtom = findChild(metaChildren, "ilst");
  const existingIlstItems = ilstAtom ? buf.subarray(ilstAtom.start + 8, ilstAtom.end) : Buffer.alloc(0);

  const newIlst = box(
    "ilst",
    Buffer.concat([existingIlstItems, ...keys.map((k) => buildFreeformAtom(k, tags[k]))])
  );
  // Rebuild `meta`'s children explicitly (hdlr first, per convention; any
  // other unrecognized child preserved as-is; `ilst` last, with the new
  // ReplayGain atoms appended) rather than patching in place, since `ilst`
  // (and possibly `hdlr`) may not have existed yet.
  const otherMetaChildren = metaChildren
    .filter((c) => c.type !== "hdlr" && c.type !== "ilst")
    .map((c) => buf.subarray(c.start, c.end));
  const hdlrBuf = hdlrAtom ? buf.subarray(hdlrAtom.start, hdlrAtom.end) : HDLR_ATOM;
  const newMetaChildren = Buffer.concat([hdlrBuf, ...otherMetaChildren, newIlst]);
  const newMeta = box("meta", Buffer.concat([metaVersionFlags, newMetaChildren]));

  const newUdtaChildren = meta
    ? replaceOrAppendChild(buf, udtaChildren, "meta", newMeta)
    : Buffer.concat([...udtaChildren.map((c) => buf.subarray(c.start, c.end)), newMeta]);
  const newUdta = box("udta", newUdtaChildren);

  const newMoovChildren = udta
    ? replaceOrAppendChild(buf, moovChildren, "udta", newUdta)
    : Buffer.concat([...moovChildren.map((c) => buf.subarray(c.start, c.end)), newUdta]);
  const newMoov = box("moov", newMoovChildren);

  const finalBuf = Buffer.concat([buf.subarray(0, moov.start), newMoov, buf.subarray(moov.end)]);

  const tmpPath = `${filePath}.rgtmp`;
  try {
    fs.writeFileSync(tmpPath, finalBuf);
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    return false;
  }
}
