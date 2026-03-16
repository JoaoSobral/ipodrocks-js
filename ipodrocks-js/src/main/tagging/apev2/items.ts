/**
 * APEv2 item builder and serializer.
 * Layout: value_size (4) + flags (4) + key + 0x00 + value
 */

import { ITEM_TYPE_UTF8, ITEM_TYPE_BINARY, MIN_ITEM_KEY_LEN, MAX_ITEM_KEY_LEN } from "./constants";
import { ApeKeyError } from "../errors";
import type { ApeItem } from "./types";

export function buildTextItem(key: string, value: string): ApeItem {
  validateKey(key);
  return { key, type: "utf8", value: Buffer.from(value, "utf8") };
}

export function buildBinaryItem(key: string, filename: string, data: Buffer): ApeItem {
  validateKey(key);
  const filenameBytes = Buffer.from(filename, "utf8");
  const nullByte = Buffer.alloc(1, 0);
  const value = Buffer.concat([filenameBytes, nullByte, data]);
  return { key, type: "binary", value };
}

export function serializeItem(item: ApeItem): Buffer {
  const keyBuf = Buffer.from(item.key, "ascii");
  const nullByte = Buffer.alloc(1, 0);
  const flags = item.type === "binary" ? ITEM_TYPE_BINARY : ITEM_TYPE_UTF8;

  const header = Buffer.allocUnsafe(8);
  header.writeUInt32LE(item.value.byteLength, 0);
  header.writeUInt32LE(flags, 4);

  return Buffer.concat([header, keyBuf, nullByte, item.value]);
}

export function validateKey(key: string): void {
  if (key.length < MIN_ITEM_KEY_LEN || key.length > MAX_ITEM_KEY_LEN) {
    throw new ApeKeyError(key, `length must be ${MIN_ITEM_KEY_LEN}-${MAX_ITEM_KEY_LEN}`);
  }
  if (!/^[\x20-\x7e]+$/.test(key)) {
    throw new ApeKeyError(key, "must contain only printable ASCII");
  }
}
