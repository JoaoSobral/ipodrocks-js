/**
 * @vitest-environment node
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect } from "vitest";
import { readAudioOnly } from "../../main/tagging/mpc/strip";
import {
  APE_PREAMBLE,
  APE_FOOTER_SIZE,
  APE_HEADER_SIZE,
  ID3V1_MAGIC,
  ID3V1_SIZE,
} from "../../main/tagging/apev2/constants";

describe("tagging/mpc/strip", () => {
  function makeTempFile(content: Buffer): string {
    const tmp = path.join(os.tmpdir(), `strip_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`);
    fs.writeFileSync(tmp, content);
    return tmp;
  }

  it("returns file unchanged when no tags", () => {
    const audio = Buffer.from([0x4d, 0x50, 0x2b, 0x01, 0x02, 0x03]);
    const file = makeTempFile(audio);
    try {
      const result = readAudioOnly(file);
      expect(result.equals(audio)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("strips APEv2 footer-only tag", () => {
    const audio = Buffer.from([0x4d, 0x50, 0x2b, 0x01, 0x02]);
    const footer = Buffer.alloc(APE_FOOTER_SIZE, 0);
    APE_PREAMBLE.copy(footer, 0);
    footer.writeUInt32LE(2000, 8);
    footer.writeUInt32LE(APE_FOOTER_SIZE, 12);
    footer.writeUInt32LE(0, 16);
    const full = Buffer.concat([audio, footer]);
    const file = makeTempFile(full);
    try {
      const result = readAudioOnly(file);
      expect(result.equals(audio)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("strips ID3v1 when present", () => {
    const audio = Buffer.from([0x4d, 0x50, 0x2b, 0x01]);
    const id3v1 = Buffer.alloc(ID3V1_SIZE, 0);
    ID3V1_MAGIC.copy(id3v1, 0);
    const full = Buffer.concat([audio, id3v1]);
    const file = makeTempFile(full);
    try {
      const result = readAudioOnly(file);
      expect(result.equals(audio)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("strips APEv2 with items", () => {
    const audio = Buffer.from([0x4d, 0x50, 0x2b]);
    const itemHeader = Buffer.alloc(8);
    itemHeader.writeUInt32LE(2, 0);
    itemHeader.writeUInt32LE(0, 4);
    const itemKey = Buffer.from("Title\0Hi", "ascii");
    const item = Buffer.concat([itemHeader, itemKey]);
    const itemsSize = item.length;
    const tagSize = itemsSize + APE_FOOTER_SIZE;
    const header = Buffer.alloc(APE_HEADER_SIZE, 0);
    APE_PREAMBLE.copy(header, 0);
    header.writeUInt32LE(2000, 8);
    header.writeUInt32LE(tagSize, 12);
    header.writeUInt32LE(1, 16);
    const footer = Buffer.alloc(APE_FOOTER_SIZE, 0);
    APE_PREAMBLE.copy(footer, 0);
    footer.writeUInt32LE(2000, 8);
    footer.writeUInt32LE(tagSize, 12);
    footer.writeUInt32LE(1, 16);
    const full = Buffer.concat([audio, header, item, footer]);
    const file = makeTempFile(full);
    try {
      const result = readAudioOnly(file);
      expect(result.equals(audio)).toBe(true);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
