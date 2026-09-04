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

export function tagsToItems(tags: ApeTags): ApeItem[] {
  const items: ApeItem[] = [];

  // APEv2 key names chosen to match MP3tag / foobar2000 conventions. Note that
  // album artist and disc use the *token* MP3tag expects — "ALBUMARTIST" (no
  // space) and "DISCNUMBER" — not "Album Artist"/"Disc", which MP3tag does not
  // recognize as those fields (it would show them as unknown custom tags). Case
  // is irrelevant to readers (all match case-insensitively); the token is not.
  const textFields: Array<[keyof ApeTags, string]> = [
    ["title", "Title"],
    ["artist", "Artist"],
    ["album", "Album"],
    ["albumArtist", "ALBUMARTIST"],
    ["genre", "Genre"],
    ["year", "Year"],
    ["originalYear", "Originalyear"],
    ["originalDate", "Originaldate"],
    ["composer", "Composer"],
    ["comment", "Comment"],
    ["compilation", "Compilation"],
    ["track", "Track"],
    ["disc", "DISCNUMBER"],
  ];

  for (const [field, key] of textFields) {
    const value = tags[field];
    if (value !== undefined && String(value).trim() !== "") {
      items.push(buildTextItem(key, String(value).trim()));
    }
  }

  // `extra` — which is where the four REPLAYGAIN_* items live — is emitted
  // BEFORE the cover art, deliberately. Rockbox parses the item list
  // sequentially into a bounded buffer, so a several-hundred-KB artwork blob
  // sitting ahead of them can consume it before they are ever read (issue
  // #125). Cheap insurance that costs nothing to keep.
  for (const [key, value] of Object.entries(tags.extra ?? {})) {
    // A legacy file whose cover item was mis-flagged as text reads back through
    // the compat path in `reader.ts`; belt and braces, never let a stray key
    // spelling the cover art produce a second, textual cover item.
    if (key.toLowerCase() === COVER_ART_KEY.toLowerCase()) continue;
    if (value !== undefined && String(value).trim() !== "") {
      items.push(buildTextItem(key, String(value).trim()));
    }
  }

  if (tags.coverArt) {
    const ext = tags.coverArt.mimeType === "image/png" ? "png" : "jpg";
    const filename = tags.coverArt.filename ?? `Cover Art (Front).${ext}`;
    items.push(buildBinaryItem(COVER_ART_KEY, filename, tags.coverArt.data));
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

