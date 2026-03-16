/**
 * Top-level APEv2 tag writer for MPC files.
 * Atomic write: tmp file + rename.
 */

import * as fs from "fs";
import { detectMpcVersion } from "./mpc/detect";
import { readAudioOnly } from "./mpc/strip";
import { buildTextItem, buildBinaryItem } from "./apev2/items";
import { buildApeBlock } from "./apev2/block";
import type { ApeTags, ApeItem, WriteResult } from "./apev2/types";

const COVER_ART_KEY = "Cover Art (Front)";

function tagsToItems(tags: ApeTags): ApeItem[] {
  const items: ApeItem[] = [];

  const textFields: Array<[keyof ApeTags, string]> = [
    ["title", "Title"],
    ["artist", "Artist"],
    ["album", "Album"],
    ["genre", "Genre"],
    ["year", "Year"],
    ["track", "Track"],
    ["disc", "Disc"],
  ];

  for (const [field, key] of textFields) {
    const value = tags[field];
    if (value !== undefined && String(value).trim() !== "") {
      items.push(buildTextItem(key, String(value).trim()));
    }
  }

  if (tags.coverArt) {
    const ext = tags.coverArt.mimeType === "image/png" ? "png" : "jpg";
    const filename = tags.coverArt.filename ?? `Cover Art (Front).${ext}`;
    items.push(buildBinaryItem(COVER_ART_KEY, filename, tags.coverArt.data));
  }

  for (const [key, value] of Object.entries(tags.extra ?? {})) {
    if (value !== undefined && String(value).trim() !== "") {
      items.push(buildTextItem(key, String(value).trim()));
    }
  }

  return items;
}

export async function writeTags(
  filePath: string,
  tags: ApeTags
): Promise<WriteResult> {
  const version = detectMpcVersion(filePath);
  const audioOnly = readAudioOnly(filePath);
  const items = tagsToItems(tags);

  let final: Buffer;
  if (items.length === 0) {
    final = audioOnly;
  } else {
    const apeBlock = buildApeBlock(items);
    final = Buffer.concat([audioOnly, apeBlock]);
  }
  const tmpPath = filePath + ".apetmp";

  try {
    fs.writeFileSync(tmpPath, final);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  return {
    bytesWritten: final.byteLength,
    itemCount: items.length,
    version,
  };
}

