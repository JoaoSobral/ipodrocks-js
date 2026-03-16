/**
 * APEv2 block serializer: header + items + footer.
 */

import {
  APE_PREAMBLE,
  APE_VERSION,
  APE_HEADER_SIZE,
  APE_FOOTER_SIZE,
  FLAG_HAS_HEADER,
  FLAG_HAS_FOOTER,
  FLAG_IS_HEADER,
} from "./constants";
import { serializeItem } from "./items";
import type { ApeItem } from "./types";

export function buildApeBlock(items: ApeItem[]): Buffer {
  const serializedItems = items.map(serializeItem);
  const itemsBuffer = Buffer.concat(serializedItems);

  const tagSize = itemsBuffer.byteLength + APE_FOOTER_SIZE;
  const itemCount = items.length;

  const header = buildTagHeader(tagSize, itemCount, true);
  const footer = buildTagHeader(tagSize, itemCount, false);

  return Buffer.concat([header, itemsBuffer, footer]);
}

function buildTagHeader(
  tagSize: number,
  itemCount: number,
  isHeader: boolean
): Buffer {
  const buf = Buffer.alloc(APE_HEADER_SIZE, 0);

  APE_PREAMBLE.copy(buf, 0);
  buf.writeUInt32LE(APE_VERSION, 8);
  buf.writeUInt32LE(tagSize, 12);
  buf.writeUInt32LE(itemCount, 16);

  let flags = FLAG_HAS_HEADER | FLAG_HAS_FOOTER;
  if (isHeader) flags |= FLAG_IS_HEADER;
  buf.writeUInt32LE(flags >>> 0, 20);

  return buf;
}
