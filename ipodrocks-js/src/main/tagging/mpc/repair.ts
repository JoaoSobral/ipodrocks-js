/**
 * In-place repair of a Musepack file iPodRocks wrote: its APEv2 tag block, and
 * the ReplayGain values in its stream header.
 *
 * Four defects, all fixed without re-encoding a byte of audio:
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
 * - **ReplayGain in the tag instead of the stream header (issue #137).**
 *   Musepack keeps ReplayGain in the header, and that is the only place a
 *   compliant player reads it; mpcenc leaves the packet zeroed, so nothing was
 *   ever applied. The repair fills it — from the file's own `REPLAYGAIN_*`
 *   items where it has them, from the source track otherwise — and then drops
 *   the tag copy, so there is one place the values live.
 *
 * The repair never touches the audio. It reads the head and the trailing tag
 * block, patches nine bytes inside the header's fixed-size `RG` packet, and
 * writes a new tag block in place of the old one — deliberately, not as an
 * optimisation: `readAudioOnly()` does a synchronous read of the entire track
 * (see the note in `library/shadow-reconcile.ts`), and doing that per file
 * across a library from an ipcMain handler would block the main process for a
 * full read of every file.
 *
 * Three properties are load-bearing:
 *
 * - **Both writes happen under one timestamp restore.** The stat is taken
 *   before either of them and the `utimes` after both, so the pass stays
 *   invisible to the device sync's mtime comparison however much it changed.
 * - **The tag block may shrink, and usually does; it may never grow.** The tag
 *   is the last thing in the file, so a shorter one is a plain truncation while
 *   a longer one would have to move bytes this module refuses to move. The
 *   header patch is size-preserving, so it cannot invalidate the block offsets
 *   computed before it ran — and a block that refuses to shrink must not throw
 *   away a header write that already succeeded.
 * - **A header-only repair still counts as `"repaired"`.** It changes neither
 *   size nor mtime, so nothing downstream would ever notice it otherwise.
 */

import * as fsp from "fs/promises";

import { APE_FOOTER_SIZE, ID3V1_SIZE } from "../apev2/constants";
import { buildApeBlock } from "../apev2/block";
import { locateApeBlock } from "../apev2/locate";
import { COVER_ART_KEY, parseApeItems } from "../reader";
import {
  hasAnyReplayGain,
  pickReplayGainStrings,
  replayGainValuesFromStrings,
  REPLAYGAIN_TAG_NAME_SET,
  type ReplayGainValues,
} from "../replaygain-keys";
import {
  canWriteSv8ReplayGainHeader,
  headBufferNeedsReplayGain,
  MPC_HEAD_PROBE_SIZE,
  writeMpcReplayGainHeader,
} from "./replaygain-header";
import type { ApeItem, RawApeItem } from "../apev2/types";

export type RepairOutcome = "repaired" | "ok" | "failed";

/**
 * The ReplayGain a caller resolved for this file, or a thunk that resolves it.
 * The thunk form exists so a resolver that shells out to ffprobe is consulted
 * only for files that might actually need it.
 */
export type ReplayGainSource =
  | Record<string, string>
  | (() => Record<string, string> | null | undefined)
  | undefined;

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

interface FileParts {
  /** The first bytes of the file: `MPCK`, `SH`, `RG`. */
  head: Buffer;
  /** The trailing APEv2 block, or null when the file carries no tag. */
  block: TailBlock | null;
}

function resolveReplayGain(source: ReplayGainSource): Record<string, string> | undefined {
  const resolved = typeof source === "function" ? source() : source;
  return resolved ?? undefined;
}

/** Read the head and the APEv2 block in one open — the two ends, no middle. */
async function readFileParts(filePath: string): Promise<FileParts | null> {
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < 8) return null;

    const headWanted = Math.min(size, MPC_HEAD_PROBE_SIZE);
    const head = Buffer.alloc(headWanted);
    await handle.read(head, 0, headWanted, 0);

    return { head, block: await readTailBlock(handle, size) };
  } finally {
    await handle.close();
  }
}

/** Parse just the APEv2 block at the end of an already-open file. */
async function readTailBlock(
  handle: fsp.FileHandle,
  size: number
): Promise<TailBlock | null> {
  if (size < PROBE_SIZE) return null;

  // First pass: the footer tells us how big the block really is.
  const probeStart = size - PROBE_SIZE;
  const probe = Buffer.alloc(PROBE_SIZE);
  await handle.read(probe, 0, PROBE_SIZE, probeStart);
  const probeLoc = locateApeBlock(probe);
  if (!probeLoc) return null;

  // Second pass: read a tail long enough to hold the whole block. The offsets
  // `locateApeBlock` returns are relative to the buffer it is given, so running
  // it again over the longer tail needs no adjustment.
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
}

/** True when this item is the artwork, however its flags happen to spell it. */
function isCoverItem(item: ApeItem): boolean {
  return item.key.toLowerCase() === COVER_ART_KEY;
}

function isReplayGainItem(item: ApeItem): boolean {
  return REPLAYGAIN_TAG_NAME_SET.has(item.key.toUpperCase());
}

function itemsAsStrings(items: RawApeItem[]): Record<string, string> {
  const strings: Record<string, string> = {};
  for (const item of items) {
    if (isReplayGainItem(item)) strings[item.key] = item.value.toString("utf8");
  }
  return strings;
}

/**
 * What the stream header should end up carrying: the file's own ReplayGain
 * items merged over whatever the caller resolved from the source track, field
 * by field. The file wins where the two disagree — those values were computed
 * for these exact bytes — but a pair the file is missing can still come from
 * the source.
 */
export function replayGainForHeader(
  items: RawApeItem[],
  sourceReplayGain?: Record<string, string>
): ReplayGainValues {
  return replayGainValuesFromStrings({
    ...pickReplayGainStrings(sourceReplayGain),
    ...pickReplayGainStrings(itemsAsStrings(items)),
  });
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
 * Decide whether a parsed item list needs rewriting on its own terms: it
 * carries artwork (which nothing embeds any more, however its flags happen to
 * read), or the source track has ReplayGain values the file is missing.
 *
 * This is the *tag's* share of the decision only — the stream header is judged
 * separately, by {@link planRepair}, because a file can need one and not the
 * other.
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

interface RepairPlan {
  items: RawApeItem[];
  source: Record<string, string> | undefined;
  headerValues: ReplayGainValues;
  /** The file has an `RG` packet this module may patch. */
  headerWritable: boolean;
  /** The packet's bytes would change. */
  headerNeedsWork: boolean;
  /** The header will carry the values, so the tag copy is redundant. */
  stripReplayGain: boolean;
  /** Artwork to remove, or ReplayGain to put back for a file with no header. */
  tagNeedsWork: boolean;
}

/**
 * One decision function for the cheap check and the repair alike — if they
 * computed this differently, the scan would report files it then leaves alone.
 */
function planRepair(parts: FileParts, replayGain: ReplayGainSource): RepairPlan {
  const items = parts.block?.items ?? [];
  const source = resolveReplayGain(replayGain);
  const headerValues = replayGainForHeader(items, source);
  const headerWritable = canWriteSv8ReplayGainHeader(parts.head);
  const headerWillCarry = headerWritable && hasAnyReplayGain(headerValues);

  return {
    items,
    source,
    headerValues,
    headerWritable,
    headerNeedsWork: headerWritable && headBufferNeedsReplayGain(parts.head, headerValues),
    stripReplayGain: headerWillCarry && items.some(isReplayGainItem),
    // A file whose header we cannot fill keeps the old behaviour: the values
    // belong in its tag, because that is the only place it has for them.
    tagNeedsWork:
      items.some(isCoverItem) ||
      (!headerWritable && missingReplayGain(items, source) !== null),
  };
}

function planNeedsWork(plan: RepairPlan): boolean {
  return plan.headerNeedsWork || plan.stripReplayGain || plan.tagNeedsWork;
}

/**
 * Cheap check: reads the head and the tag block, never the audio. Returns false
 * for a file with nothing to fix — so the repair pass is idempotent and a
 * second run reports zero.
 */
export async function needsApeRepair(
  filePath: string,
  replayGain?: ReplayGainSource
): Promise<boolean> {
  try {
    const parts = await readFileParts(filePath);
    return parts ? planNeedsWork(planRepair(parts, replayGain)) : false;
  } catch {
    return false;
  }
}

/**
 * Fill the stream header's ReplayGain packet and rewrite the tag block: drop
 * the artwork, drop the now-redundant `REPLAYGAIN_*` items, and re-serialize
 * everything else with the correct type bits. Returns "ok" when there was
 * nothing to fix.
 *
 * @param replayGain Values read from the track this file was transcoded from,
 *   keyed `REPLAYGAIN_*`, or a thunk returning them. Omitted when the caller
 *   cannot resolve a source — in which case the file's own tag still feeds the
 *   header, and the artwork strip still happens.
 */
export async function repairMpcTags(
  filePath: string,
  replayGain?: ReplayGainSource
): Promise<RepairOutcome> {
  let parts: FileParts | null;
  try {
    parts = await readFileParts(filePath);
  } catch {
    return "failed";
  }
  if (!parts) return "ok";

  const plan = planRepair(parts, replayGain);
  if (!planNeedsWork(plan)) return "ok";

  // One timestamp read, taken before either write and restored after both.
  let atimeSec: number;
  let mtimeSec: number;
  try {
    const stat = await fsp.stat(filePath, { bigint: true });
    atimeSec = Number(stat.atimeNs) / 1e9;
    mtimeSec = Number(stat.mtimeNs) / 1e9;
  } catch {
    return "failed";
  }

  let wrote = false;

  // The header first. It is size-preserving, so the block offsets taken from
  // the read above are still correct afterwards.
  if (plan.headerNeedsWork) {
    const outcome = await writeMpcReplayGainHeader(filePath, plan.headerValues);
    if (outcome === "failed") return "failed";
    if (outcome === "written") wrote = true;
    if (outcome === "unsupported") {
      // Nothing to fill. Anything that depended on the header being filled —
      // the strip — is off the table.
      plan.stripReplayGain = false;
    }
  }

  if (parts.block && (plan.tagNeedsWork || plan.stripReplayGain)) {
    const rewritten: ApeItem[] = plan.items
      // Artwork goes. `parseApeItems` resolves a legacy mis-flagged cover item
      // back to "binary" by name, so this catches the broken ones too.
      .filter((item) => !isCoverItem(item))
      // ReplayGain goes once the header carries it: the header is what a player
      // reads, and two copies are two things to disagree (#137).
      .filter((item) => !(plan.stripReplayGain && isReplayGainItem(item)))
      .map(({ key, type, value }) => ({ key, type, value }));

    for (const [key, value] of Object.entries(
      (plan.stripReplayGain ? null : missingReplayGain(plan.items, plan.source)) ?? {}
    )) {
      rewritten.push({ key, type: "utf8", value: Buffer.from(value, "utf8") });
    }

    let rebuilt: Buffer | null = null;
    try {
      rebuilt = buildApeBlock(rewritten);
    } catch {
      rebuilt = null;
    }

    // The block may shrink — dropping a cover is the point — but it must never
    // grow. The tag is the last thing in the file, so a shorter one truncates
    // cleanly, while a longer one would mean moving bytes this module refuses
    // to move. Adding a few ReplayGain items to a file that had a cover always
    // nets out smaller; adding them to one that did not can grow it, so refuse.
    if (rebuilt && rebuilt.byteLength <= parts.block.blockSize) {
      const ok = await writeTagBlock(filePath, parts.block, rebuilt);
      if (!ok && !wrote) return "failed";
      if (ok) wrote = true;
    } else if (!wrote) {
      return "failed";
    }
    // A refusal with the header already written falls through: the file is
    // better than it was, the timestamp still has to be restored, and reporting
    // "failed" would claim otherwise.
  }

  try {
    await fsp.utimes(filePath, atimeSec, mtimeSec);
  } catch {
    return "failed";
  }

  return wrote ? "repaired" : "ok";
}

/** Write the rebuilt block over the old one and truncate what it no longer uses. */
async function writeTagBlock(
  filePath: string,
  block: TailBlock,
  rebuilt: Buffer
): Promise<boolean> {
  // Whatever sits after the APE block (an ID3v1 tag) moves down with it.
  const trailer = Buffer.from(block.tail.subarray(block.blockStart + block.blockSize));
  const absoluteStart = block.tailStart + block.blockStart;

  try {
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
    return true;
  } catch {
    return false;
  }
}
