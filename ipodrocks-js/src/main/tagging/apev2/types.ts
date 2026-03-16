/**
 * TypeScript interfaces for APEv2 tagging.
 */

export type ItemType = "utf8" | "binary";

export interface ApeItem {
  key: string;
  type: ItemType;
  value: Buffer;
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
  genre?: string;
  year?: string;
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
