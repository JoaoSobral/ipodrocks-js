/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { buildApeBlock } from "../../main/tagging/apev2/block";
import { buildTextItem } from "../../main/tagging/apev2/items";
import { APE_PREAMBLE, APE_VERSION, APE_HEADER_SIZE, APE_FOOTER_SIZE } from "../../main/tagging/apev2/constants";

describe("tagging/apev2/block", () => {
  it("produces header with correct magic and version", () => {
    const items = [buildTextItem("Title", "x")];
    const block = buildApeBlock(items);
    expect(block.subarray(0, 8).equals(APE_PREAMBLE)).toBe(true);
    expect(block.readUInt32LE(8)).toBe(APE_VERSION);
  });

  it("tag_size includes items + footer", () => {
    const items = [buildTextItem("Title", "Hi")];
    const block = buildApeBlock(items);
    const tagSize = block.readUInt32LE(12);
    const itemsLen = 4 + 4 + 5 + 1 + 2;
    expect(tagSize).toBe(itemsLen + APE_FOOTER_SIZE);
  });

  it("item count is correct", () => {
    const items = [
      buildTextItem("Title", "A"),
      buildTextItem("Artist", "B"),
    ];
    const block = buildApeBlock(items);
    expect(block.readUInt32LE(16)).toBe(2);
  });

  it("header has IS_HEADER bit set, footer does not", () => {
    const items = [buildTextItem("Title", "x")];
    const block = buildApeBlock(items);
    const headerFlags = block.readUInt32LE(20);
    const footerStart = block.length - APE_FOOTER_SIZE;
    const footerFlags = block.readUInt32LE(footerStart + 20);
    const FLAG_IS_HEADER = 1 << 29;
    expect(headerFlags & FLAG_IS_HEADER).toBe(FLAG_IS_HEADER);
    expect(footerFlags & FLAG_IS_HEADER).toBe(0);
  });

  it("block has header + items + footer structure", () => {
    const items = [buildTextItem("Title", "Test")];
    const block = buildApeBlock(items);
    expect(block.length).toBeGreaterThanOrEqual(APE_HEADER_SIZE + APE_FOOTER_SIZE);
    const footerStart = block.length - APE_FOOTER_SIZE;
    expect(block.subarray(footerStart, footerStart + 8).equals(APE_PREAMBLE)).toBe(true);
  });
});
