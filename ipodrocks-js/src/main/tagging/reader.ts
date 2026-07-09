/**
 * APEv2 tag reader for MPC files.
 *
 * This exists as a workaround: `music-metadata` throws a RangeError parsing any
 * SV8 Musepack file that carries an APEv2 tag, so every tagged MPC file we (or
 * a user) generate fails its `parseFile` path. We read the tags ourselves — the
 * exact inverse of the write-direction primitives in `writer.ts` / `items.ts` —
 * and leave format/audio info to `parseBuffer` over the tag-stripped audio.
 */

import * as fs from "fs";
import { ITEM_TYPE_BINARY } from "./apev2/constants";
import { locateApeBlock, type ApeBlockLocation } from "./apev2/locate";
import type { ApeItem, ApeTags, CoverArt } from "./apev2/types";

const COVER_ART_KEY = "cover art (front)";

/**
 * Inverse of `writer.ts` `textFields`, keyed by lower-cased APEv2 key name.
 * Accepts both the current tokens (ALBUMARTIST/DISCNUMBER) and the legacy
 * "Album Artist"/"Disc" forms iPodRocks wrote before, plus common variants
 * other taggers use, so any tagged MPC scans correctly.
 */
const TEXT_FIELD_BY_KEY: Record<string, keyof ApeTags> = {
  title: "title",
  artist: "artist",
  album: "album",
  albumartist: "albumArtist",
  "album artist": "albumArtist",
  genre: "genre",
  year: "year",
  originalyear: "originalYear",
  originaldate: "originalDate",
  composer: "composer",
  comment: "comment",
  compilation: "compilation",
  track: "track",
  tracknumber: "track",
  disc: "disc",
  discnumber: "disc",
};

/**
 * Read the APEv2 tags from an MPC file. Returns `{}` when there is no tag or
 * the tag block is malformed — never throws for tag content.
 */
export function readApeTags(filePath: string): ApeTags {
  const full = fs.readFileSync(filePath);
  const loc = locateApeBlock(full);
  if (!loc) return {};
  return itemsToTags(parseItems(full, loc));
}

/** Parse the item list. Stops (returning what it has) on any malformed read. */
function parseItems(full: Buffer, loc: ApeBlockLocation): ApeItem[] {
  const items: ApeItem[] = [];
  const limit = Math.min(full.byteLength, loc.itemsStart + loc.itemsSize);
  let pos = loc.itemsStart;

  for (let i = 0; i < loc.itemCount; i++) {
    // value_size (4) + flags (4)
    if (pos + 8 > limit) break;
    const valueSize = full.readUInt32LE(pos);
    const flags = full.readUInt32LE(pos + 4);
    pos += 8;

    // key: printable ASCII terminated by a null byte
    let keyEnd = pos;
    while (keyEnd < limit && full[keyEnd] !== 0) keyEnd++;
    if (keyEnd >= limit) break; // no terminator → truncated
    const key = full.toString("ascii", pos, keyEnd);
    pos = keyEnd + 1;

    if (pos + valueSize > limit) break; // value runs past the block
    const value = Buffer.from(full.subarray(pos, pos + valueSize));
    pos += valueSize;

    const type = (flags & 3) === ITEM_TYPE_BINARY ? "binary" : "utf8";
    items.push({ key, type, value });
  }

  return items;
}

function itemsToTags(items: ApeItem[]): ApeTags {
  const tags: ApeTags = {};
  const extra: Record<string, string> = {};

  for (const item of items) {
    const lowerKey = item.key.toLowerCase();

    if (item.type === "binary") {
      if (lowerKey === COVER_ART_KEY) {
        const cover = parseCoverArt(item.value);
        if (cover) tags.coverArt = cover;
      }
      continue;
    }

    const value = item.value.toString("utf8");
    const field = TEXT_FIELD_BY_KEY[lowerKey];
    if (field) {
      (tags as Record<string, unknown>)[field] = value;
    } else {
      extra[item.key] = value;
    }
  }

  if (Object.keys(extra).length > 0) tags.extra = extra;
  return tags;
}

/** Binary cover value is `filename\0data`, matching `buildBinaryItem`. */
function parseCoverArt(value: Buffer): CoverArt | null {
  const nullIdx = value.indexOf(0);
  if (nullIdx < 0) return null;
  const filename = value.toString("utf8", 0, nullIdx);
  const data = Buffer.from(value.subarray(nullIdx + 1));
  if (data.length === 0) return null;
  return {
    data,
    mimeType: sniffMime(filename, data),
    filename: filename || undefined,
  };
}

function sniffMime(filename: string, data: Buffer): "image/png" | "image/jpeg" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  // PNG magic: 89 50 4E 47
  if (
    data.length >= 4 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  return "image/jpeg";
}
