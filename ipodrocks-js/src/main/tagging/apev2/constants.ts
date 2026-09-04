/**
 * APEv2 and MPC format constants from the specification.
 * https://wiki.hydrogenaud.io/index.php?title=APEv2_specification
 */

export const APE_PREAMBLE = Buffer.from("APETAGEX", "ascii");
export const APE_VERSION = 2000;
export const APE_HEADER_SIZE = 32;
export const APE_FOOTER_SIZE = 32;

/** Global flags (bit positions). */
export const FLAG_HAS_HEADER = 1 << 31;
export const FLAG_HAS_FOOTER = 1 << 30;
export const FLAG_IS_HEADER = 1 << 29;

/**
 * Item type, held in **bits 1-2** of the item flags word — bit 0 is the
 * read-only flag, not part of the type. Writing the type unshifted (binary as
 * `1` rather than `2`) marks the item "read-only UTF-8 text" instead, and since
 * APEv2 text values are NUL-separated multi-values, every reader then splits a
 * JPEG into thousands of mostly-empty values and never reaches the items that
 * follow it. That shipped, and is issue #125 — see `tagging/mpc/repair.ts`.
 */
export const ITEM_TYPE_MASK = 0b110;
export const ITEM_TYPE_UTF8 = 0b000;
export const ITEM_TYPE_BINARY = 0b010;

/** Read the item type bits out of a raw item flags word. */
export function itemTypeFromFlags(flags: number): number {
  return flags & ITEM_TYPE_MASK;
}

/** MPC magic bytes. */
export const MPC_SV7_MAGIC = Buffer.from([0x4d, 0x50, 0x2b]); // "MP+"
export const MPC_SV8_MAGIC = Buffer.from("MPCK", "ascii");
export const ID3V1_MAGIC = Buffer.from("TAG", "ascii");
export const ID3V1_SIZE = 128;

export const MAX_ITEM_KEY_LEN = 255;
export const MIN_ITEM_KEY_LEN = 2;
