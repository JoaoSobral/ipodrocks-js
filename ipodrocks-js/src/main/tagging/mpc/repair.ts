/**
 * In-place repair of the malformed APEv2 cover-art item iPodRocks wrote into
 * every tagged Musepack file before the issue #125 fix.
 *
 * Two things were wrong and both are fixed by rewriting the tag block alone:
 *
 * - the cover-art item carried flags `1` — "read-only UTF-8 text" — instead of
 *   the binary type bits, so every reader split the JPEG on its NUL bytes into
 *   thousands of mostly-empty values;
 * - the cover art was emitted *before* the `REPLAYGAIN_*` items, so a reader
 *   with a bounded tag buffer (Rockbox) never reached them.
 *
 * The repair never touches the audio. It reads only the trailing tag block,
 * re-serializes it and writes it back at the same offset — deliberately, not
 * as an optimisation: `readAudioOnly()` does a synchronous read of the entire
 * track (see the note in `library/shadow-reconcile.ts`), and doing that per
 * file across a library from an ipcMain handler would block the main process
 * for a full read of every file.
 *
 * Because the repair changes no value lengths — only a flags word and the
 * order items appear in — the new block is the same size as the old one. That
 * keeps the file size identical, and restoring the mtime afterwards makes the
 * whole pass invisible to `shadow_tracks`' stat baseline and to the device
 * sync's name+size+mtime comparison: nothing re-transcodes, nothing re-copies.
 */

import * as fsp from "fs/promises";

import {
  APE_FOOTER_SIZE,
  ID3V1_SIZE,
  ITEM_TYPE_BINARY,
  itemTypeFromFlags,
} from "../apev2/constants";
import { buildApeBlock } from "../apev2/block";
import { locateApeBlock } from "../apev2/locate";
import { COVER_ART_KEY, parseApeItems } from "../reader";
import type { ApeItem, RawApeItem } from "../apev2/types";

export type RepairOutcome = "repaired" | "ok" | "failed";

/**
 * Enough of the end of the file to hold a footer plus an ID3v1 tag. Read first
 * so the real block size can be taken from the footer rather than guessed.
 */
const PROBE_SIZE = APE_FOOTER_SIZE + ID3V1_SIZE;

interface TailBlock {
  /** The tail bytes actually read. */
  tail: Buffer;
  /** Absolute file offset the tail starts at. */
  tailStart: number;
  /** Offset of the APE block within `tail`. */
  blockStart: number;
  /** Byte length of the APE block (header + items + footer). */
  blockSize: number;
  items: RawApeItem[];
}

/** Read and parse just the APEv2 block at the end of `filePath`. */
async function readTailBlock(filePath: string): Promise<TailBlock | null> {
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < PROBE_SIZE) return null;

    // First pass: the footer tells us how big the block really is.
    const probeStart = size - PROBE_SIZE;
    const probe = Buffer.alloc(PROBE_SIZE);
    await handle.read(probe, 0, PROBE_SIZE, probeStart);
    const probeLoc = locateApeBlock(probe);
    if (!probeLoc) return null;

    // Second pass: read a tail long enough to hold the whole block. The
    // offsets `locateApeBlock` returns are relative to the buffer it is given,
    // so running it again over the longer tail needs no adjustment.
    const wanted = Math.min(size, probeLoc.itemsSize + APE_FOOTER_SIZE * 2 + ID3V1_SIZE);
    const tailStart = size - wanted;
    const tail = Buffer.alloc(wanted);
    await handle.read(tail, 0, wanted, tailStart);

    const loc = locateApeBlock(tail);
    if (!loc) return null;

    const blockEnd = loc.itemsStart + loc.itemsSize + APE_FOOTER_SIZE;
    return {
      tail,
      tailStart,
      blockStart: loc.audioEnd,
      blockSize: blockEnd - loc.audioEnd,
      items: parseApeItems(tail, loc),
    };
  } finally {
    await handle.close();
  }
}

/** True when this item is the artwork, however its flags happen to spell it. */
function isCoverItem(item: ApeItem): boolean {
  return item.key.toLowerCase() === COVER_ART_KEY;
}

function isReplayGainItem(item: ApeItem): boolean {
  return item.key.toLowerCase().startsWith("replaygain_");
}

/**
 * Decide whether a parsed item list carries the #125 defect: a cover-art item
 * whose flags do not say binary, or ReplayGain sitting behind the artwork.
 * Both are fixed by the same rewrite, so both are worth reporting.
 */
export function itemsNeedRepair(items: RawApeItem[]): boolean {
  const coverIndex = items.findIndex(isCoverItem);
  if (coverIndex < 0) return false;

  if (itemTypeFromFlags(items[coverIndex].flags) !== ITEM_TYPE_BINARY) return true;

  return items.some((item, i) => i > coverIndex && isReplayGainItem(item));
}

/**
 * Cheap check: reads only the tag block, never the audio. Returns false for a
 * file with no tag, no artwork, or an already-correct one — so the repair pass
 * is idempotent and a second run reports zero.
 */
export async function needsApeRepair(filePath: string): Promise<boolean> {
  try {
    const block = await readTailBlock(filePath);
    return block ? itemsNeedRepair(block.items) : false;
  } catch {
    return false;
  }
}

/**
 * Rewrite the tag block with the correct item-type flags and with the artwork
 * moved behind every text item. Returns "ok" when there was nothing to fix.
 */
export async function repairMpcTags(filePath: string): Promise<RepairOutcome> {
  let block: TailBlock | null;
  try {
    block = await readTailBlock(filePath);
  } catch {
    return "failed";
  }
  if (!block || !itemsNeedRepair(block.items)) return "ok";

  // `parseApeItems` has already resolved the legacy mis-flagged cover item back
  // to "binary", so re-serializing writes the correct type bits. Text first,
  // artwork last; the relative order within each group is preserved.
  const reordered: ApeItem[] = [
    ...block.items.filter((i) => i.type !== "binary"),
    ...block.items.filter((i) => i.type === "binary"),
  ].map(({ key, type, value }) => ({ key, type, value }));

  let rebuilt: Buffer;
  try {
    rebuilt = buildApeBlock(reordered);
  } catch {
    return "failed";
  }

  // Same items and same value lengths, so this must come out the same size. If
  // it somehow does not, refuse rather than shift anything that follows the
  // block on disk (an ID3v1 tag) or leave a truncated tail behind.
  if (rebuilt.byteLength !== block.blockSize) return "failed";

  const absoluteStart = block.tailStart + block.blockStart;
  try {
    // Read the timestamps at nanosecond resolution and hand them back as
    // fractional *seconds*. Passing the `Date` form instead loses close to a
    // millisecond, and that is not a rounding nicety: `shadow_tracks.mtime`
    // stores `Math.floor(mtimeMs)` and compares it for equality, so a sub-
    // millisecond drift can shift the floored value by one and make the
    // reconcile pass stop trusting a file this repair did not really change.
    const stat = await fsp.stat(filePath, { bigint: true });
    const atimeSec = Number(stat.atimeNs) / 1e9;
    const mtimeSec = Number(stat.mtimeNs) / 1e9;

    const handle = await fsp.open(filePath, "r+");
    try {
      await handle.write(rebuilt, 0, rebuilt.byteLength, absoluteStart);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.utimes(filePath, atimeSec, mtimeSec);
  } catch {
    return "failed";
  }

  return "repaired";
}
