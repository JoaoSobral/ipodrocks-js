/**
 * TypeScript interfaces for APEv2 tagging.
 */

export type ItemType = "utf8" | "binary";

export interface ApeItem {
  key: string;
  type: ItemType;
  value: Buffer;
}

/**
 * An item as read off disk. `flags` is the raw word, kept because the repair
 * pass (issue #125) has to tell a correctly-flagged binary item from a legacy
 * mis-flagged one, a distinction `type` deliberately erases.
 */
export interface RawApeItem extends ApeItem {
  flags: number;
}

export interface CoverArt {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  filename?: string;
}

export interface ApeTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: string;
  originalYear?: string;
  originalDate?: string;
  composer?: string;
  comment?: string;
  compilation?: string;
  track?: string;
  disc?: string;
  coverArt?: CoverArt;
  extra?: Record<string, string>;
}

export type MpcVersion = "SV7" | "SV8";

export interface WriteResult {
  bytesWritten: number;
  itemCount: number;
  version: MpcVersion;
}
