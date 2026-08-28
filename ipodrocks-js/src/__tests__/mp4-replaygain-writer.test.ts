/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { writeM4aReplayGainTags } from "../main/tagging/mp4/replaygain-writer";

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function box(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32be(payload.length + 8), Buffer.from(type, "ascii"), payload]);
}

/** Minimal but structurally valid top-level box list: ftyp, mdat, moov. */
function buildMp4(moovChildren: Buffer, moovBeforeMdat = false): Buffer {
  const ftyp = box("ftyp", Buffer.from("M4A isom", "ascii"));
  const mdat = box("mdat", Buffer.from("fake-audio-bytes"));
  const moov = box("moov", moovChildren);
  return moovBeforeMdat
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);
}

/** Local, test-only box reader — an independent oracle from the module under test. */
interface ReadBox {
  type: string;
  payload: Buffer;
}

function readChildren(buf: Buffer, start: number, end: number): ReadBox[] {
  const out: ReadBox[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const size = buf.readUInt32BE(pos);
    // latin1, not ascii: fourcc bytes like the copyright sign (0xa9) in "©too"
    // are single bytes outside the 7-bit ASCII range and must map 1:1 to match.
    const type = buf.toString("latin1", pos + 4, pos + 8);
    out.push({ type, payload: buf.subarray(pos + 8, pos + size) });
    pos += size;
  }
  return out;
}

function readFreeformAtoms(ilstPayload: Buffer): Array<{ name: string; value: string }> {
  const atoms: Array<{ name: string; value: string }> = [];
  for (const child of readChildren(ilstPayload, 0, ilstPayload.length)) {
    if (child.type !== "----") continue;
    const parts = readChildren(child.payload, 0, child.payload.length);
    const nameAtom = parts.find((p) => p.type === "name");
    const dataAtom = parts.find((p) => p.type === "data");
    if (!nameAtom || !dataAtom) continue;
    atoms.push({
      name: nameAtom.payload.subarray(4).toString("utf8"),
      value: dataAtom.payload.subarray(8).toString("utf8"),
    });
  }
  return atoms;
}

function findIlstPayload(buf: Buffer): Buffer | undefined {
  const top = readChildren(buf, 0, buf.length);
  let pos = 0;
  for (const t of top) {
    if (t.type === "moov") {
      for (const udta of readChildren(t.payload, 0, t.payload.length)) {
        if (udta.type !== "udta") continue;
        for (const meta of readChildren(udta.payload, 0, udta.payload.length)) {
          if (meta.type !== "meta") continue;
          for (const ilst of readChildren(meta.payload, 4, meta.payload.length)) {
            if (ilst.type === "ilst") return ilst.payload;
          }
        }
      }
    }
    pos += 8 + t.payload.length;
  }
  return undefined;
}

describe("writeM4aReplayGainTags", () => {
  let workDir: string;
  let filePath: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "m4a-rg-"));
    filePath = path.join(workDir, "test.m4a");
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("builds the full udta/meta/ilst chain from scratch and writes the atoms", () => {
    fs.writeFileSync(filePath, buildMp4(Buffer.alloc(0)));

    const ok = writeM4aReplayGainTags(filePath, {
      replaygain_track_gain: "-3.38 dB",
      replaygain_track_peak: "0.998054",
    });
    expect(ok).toBe(true);

    const ilst = findIlstPayload(fs.readFileSync(filePath));
    expect(ilst).toBeDefined();
    const atoms = readFreeformAtoms(ilst as Buffer);
    expect(atoms).toEqual(
      expect.arrayContaining([
        { name: "replaygain_track_gain", value: "-3.38 dB" },
        { name: "replaygain_track_peak", value: "0.998054" },
      ])
    );
  });

  it("preserves an existing ilst item and appends the new ReplayGain atoms after it", () => {
    // "©too" (encoder) — the copyright-sign fourcc byte (0xa9) isn't ASCII, so
    // build its header directly rather than through the ASCII-only `box()` helper.
    const tooPayload = box("data", Buffer.concat([u32be(1), u32be(0), Buffer.from("Lavf", "utf8")]));
    const existingItem = Buffer.concat([
      u32be(tooPayload.length + 8),
      Buffer.from([0xa9, 0x74, 0x6f, 0x6f]),
      tooPayload,
    ]);
    const ilst = box("ilst", existingItem);
    const hdlr = box(
      "hdlr",
      Buffer.concat([u32be(0), u32be(0), Buffer.from("mdir", "ascii"), Buffer.from("appl", "ascii"), u32be(0), u32be(0), Buffer.from([0])])
    );
    const meta = box("meta", Buffer.concat([u32be(0), hdlr, ilst]));
    const udta = box("udta", meta);
    fs.writeFileSync(filePath, buildMp4(udta));

    const ok = writeM4aReplayGainTags(filePath, { replaygain_album_gain: "-2.32 dB" });
    expect(ok).toBe(true);

    const newIlst = findIlstPayload(fs.readFileSync(filePath)) as Buffer;
    const children = readChildren(newIlst, 0, newIlst.length);
    expect(children.some((c) => c.type === "©too")).toBe(true);
    expect(readFreeformAtoms(newIlst)).toEqual([{ name: "replaygain_album_gain", value: "-2.32 dB" }]);
  });

  it("refuses to touch the file when moov precedes mdat", () => {
    const before = buildMp4(Buffer.alloc(0), /* moovBeforeMdat */ true);
    fs.writeFileSync(filePath, before);

    const ok = writeM4aReplayGainTags(filePath, { replaygain_track_gain: "-3.38 dB" });
    expect(ok).toBe(false);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("returns false and does nothing when there are no tags to write", () => {
    const before = buildMp4(Buffer.alloc(0));
    fs.writeFileSync(filePath, before);

    const ok = writeM4aReplayGainTags(filePath, {});
    expect(ok).toBe(false);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("returns false when the file doesn't exist", () => {
    const ok = writeM4aReplayGainTags(path.join(workDir, "missing.m4a"), {
      replaygain_track_gain: "-3.38 dB",
    });
    expect(ok).toBe(false);
  });
});
