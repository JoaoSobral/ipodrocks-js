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

/** Item type flags (bits 0-1 of item flags). */
export const ITEM_TYPE_UTF8 = 0;
export const ITEM_TYPE_BINARY = 1;

/** MPC magic bytes. */
export const MPC_SV7_MAGIC = Buffer.from([0x4d, 0x50, 0x2b]); // "MP+"
export const MPC_SV8_MAGIC = Buffer.from("MPCK", "ascii");
export const ID3V1_MAGIC = Buffer.from("TAG", "ascii");
export const ID3V1_SIZE = 128;

export const MAX_ITEM_KEY_LEN = 255;
export const MIN_ITEM_KEY_LEN = 2;
