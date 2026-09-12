/**
 * In-place repair of the APEv2 tag block in a Musepack file iPodRocks wrote.
 *
 * Three defects, all fixed by rewriting the trailing tag block alone:
 *
 * - **The malformed cover-art item (issue #125).** It carried flags `1` —
 *   "read-only UTF-8 text" — instead of the binary type bits, so every reader
 *   split the JPEG on its NUL bytes into thousands of mostly-empty values.
 * - **ReplayGain sitting behind the artwork (issue #125).** A reader with a
 *   bounded tag buffer (Rockbox) filled it on the image and never reached the
 *   `REPLAYGAIN_*` items that followed.
 * - **The artwork itself, and missing ReplayGain (issue #130).** iPodRocks no
 *   longer embeds a picture at all — Rockbox reads the `cover.jpg` written
 *   beside the audio — so the repair strips one when it finds one, and puts
 *   back any ReplayGain values the source track still has.
 *
 * The repair never touches the audio. It reads only the trailing tag block and
 * writes a new one in its place — deliberately, not as an optimisation:
 * `readAudioOnly()` does a synchronous read of the entire track (see the note
 * in `library/shadow-reconcile.ts`), and doing that per file across a library
 * from an ipcMain handler would block the main process for a full read of
 * every file.
 *
 * **The block may now shrink, and usually does** — stripping a cover is the
 * point. It may never grow: the tag is the last thing in the file, so a
 * shorter one is a plain truncation, while a longer one would have to move
 * bytes this module refuses to move. The mtime is still restored afterwards,
 * so the pass stays invisible to the device sync's mtime comparison; the size
 * is not, and `maintenance:repairMpcTags` refreshes the `shadow_tracks` stat
 * baseline for what it changed.
 */

import * as fsp from "fs/promises";

import { APE_FOOTER_SIZE, ID3V1_SIZE } from "../apev2/constants";
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

/**
 * Decide whether a parsed item list needs rewriting: it carries artwork (which
 * nothing embeds any more, however its flags happen to read), or the source
 * track has ReplayGain values the file is missing.
 */
export function itemsNeedRepair(
  items: RawApeItem[],
  replayGain?: Record<string, string>
): boolean {
  // Artwork is no longer written into these files at all, so any cover item is
  // something to remove rather than something to correct.
  if (items.some(isCoverItem)) return true;

  // Anything the source still has that the file does not.
  return missingReplayGain(items, replayGain) !== null;
}

/**
 * The ReplayGain entries present on the source but absent from the file, or
 * null when there is nothing to add. Matched case-insensitively: the file may
 * spell them any way an earlier version or another tagger did.
 */
function missingReplayGain(
  items: RawApeItem[],
  replayGain: Record<string, string> | undefined
): Record<string, string> | null {
  if (!replayGain) return null;
  const present = new Set(items.map((i) => i.key.toUpperCase()));
  const missing: Record<string, string> = {};
  for (const [key, value] of Object.entries(replayGain)) {
    if (!present.has(key.toUpperCase())) missing[key] = value;
  }
  return Object.keys(missing).length > 0 ? missing : null;
}

/**
 * Cheap check: reads only the tag block, never the audio. Returns false for a
 * file with no tag, no artwork, or an already-correct one — so the repair pass
 * is idempotent and a second run reports zero.
 */
export async function needsApeRepair(
  filePath: string,
  replayGain?: Record<string, string>
): Promise<boolean> {
  try {
    const block = await readTailBlock(filePath);
    return block ? itemsNeedRepair(block.items, replayGain) : false;
  } catch {
    return false;
  }
}

/**
 * Rewrite the tag block: drop the artwork, restore any ReplayGain the source
 * still has, and re-serialize everything else with the correct type bits.
 * Returns "ok" when there was nothing to fix.
 *
 * @param replayGain Values read from the track this file was transcoded from,
 *   keyed `REPLAYGAIN_*`. Omitted when the caller cannot resolve a source, in
 *   which case the artwork strip still happens and ReplayGain is left alone.
 */
export async function repairMpcTags(
  filePath: string,
  replayGain?: Record<string, string>
): Promise<RepairOutcome> {
  let block: TailBlock | null;
  try {
    block = await readTailBlock(filePath);
  } catch {
    return "failed";
  }
  if (!block || !itemsNeedRepair(block.items, replayGain)) return "ok";

  const missing = missingReplayGain(block.items, replayGain);
  const rewritten: ApeItem[] = block.items
    // Artwork goes. `parseApeItems` resolves a legacy mis-flagged cover item
    // back to "binary" by name, so this catches the broken ones too.
    .filter((item) => !isCoverItem(item))
    .map(({ key, type, value }) => ({ key, type, value }));

  for (const [key, value] of Object.entries(missing ?? {})) {
    rewritten.push({ key, type: "utf8", value: Buffer.from(value, "utf8") });
  }

  let rebuilt: Buffer;
  try {
    rebuilt = buildApeBlock(rewritten);
  } catch {
    return "failed";
  }

  // The block may shrink — dropping a cover is the point — but it must never
  // grow. The tag is the last thing in the file, so a shorter one truncates
  // cleanly, while a longer one would mean moving bytes this module refuses to
  // move. Adding a few ReplayGain items to a file that had a cover always nets
  // out smaller; adding them to one that did not can grow it, so refuse.
  if (rebuilt.byteLength > block.blockSize) return "failed";

  // Whatever sits after the APE block (an ID3v1 tag) moves down with it.
  const trailer = Buffer.from(
    block.tail.subarray(block.blockStart + block.blockSize)
  );

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
      const payload = Buffer.concat([rebuilt, trailer]);
      await handle.write(payload, 0, payload.byteLength, absoluteStart);
      // The new tag is shorter than the old one whenever a cover came out, so
      // drop whatever is left of it rather than leaving a tail of garbage that
      // the next reader would try to parse.
      await handle.truncate(absoluteStart + payload.byteLength);
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
