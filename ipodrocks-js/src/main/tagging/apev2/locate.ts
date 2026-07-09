/**
 * Locate the APEv2 tag block at the end of an MPC file buffer.
 *
 * The footer-math here is the read-direction inverse of `block.ts` and is
 * shared by both the tag stripper (`mpc/strip.ts`) and the tag reader
 * (`reader.ts`), so the two agree byte-for-byte on where audio ends and the
 * item list begins.
 */

import {
  APE_PREAMBLE,
  APE_FOOTER_SIZE,
  APE_HEADER_SIZE,
  ID3V1_MAGIC,
  ID3V1_SIZE,
} from "./constants";

export interface ApeBlockLocation {
  /** Byte offset where audio ends (= start of the APE tag block). */
  audioEnd: number;
  /** Byte offset of the first item (after the optional header). */
  itemsStart: number;
  /** Total byte length of the item list. */
  itemsSize: number;
  /** Number of items declared in the footer. */
  itemCount: number;
}

/** Length of `full` with a trailing ID3v1 tag removed, if present. */
export function endWithoutId3v1(full: Buffer): number {
  const end = full.byteLength;
  if (end >= ID3V1_SIZE) {
    const id3Start = end - ID3V1_SIZE;
    if (full.subarray(id3Start, id3Start + 3).equals(ID3V1_MAGIC)) {
      return end - ID3V1_SIZE;
    }
  }
  return end;
}

/**
 * Find the APEv2 block by matching the footer preamble. Returns null when
 * there is no valid trailing APE tag.
 */
export function locateApeBlock(full: Buffer): ApeBlockLocation | null {
  const end = endWithoutId3v1(full);
  if (end < APE_FOOTER_SIZE) return null;

  const footerStart = end - APE_FOOTER_SIZE;
  if (!full.subarray(footerStart, footerStart + 8).equals(APE_PREAMBLE)) {
    return null;
  }

  const tagSize = full.readUInt32LE(footerStart + 12);
  const itemCount = full.readUInt32LE(footerStart + 16);

  // `tagSize` covers the item list plus the footer. When items are present the
  // writer always emits a header too — the same heuristic `strip.ts` used.
  const hasHeader = tagSize > APE_FOOTER_SIZE;
  const blockSize = hasHeader ? tagSize + APE_HEADER_SIZE : tagSize;
  const blockStart = Math.max(0, end - blockSize);

  return {
    audioEnd: blockStart,
    itemsStart: hasHeader ? blockStart + APE_HEADER_SIZE : blockStart,
    itemsSize: Math.max(0, tagSize - APE_FOOTER_SIZE),
    itemCount,
  };
}
