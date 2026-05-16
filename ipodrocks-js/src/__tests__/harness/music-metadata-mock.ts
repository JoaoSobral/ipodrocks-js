/**
 * Shared `music-metadata` mock used by behavioral and regression tests.
 *
 * Usage:
 *   import { installMusicMetadataMock, registerFixture } from "./music-metadata-mock";
 *
 *   installMusicMetadataMock(); // call at module scope BEFORE importing app code
 *
 *   beforeEach(() => resetMusicMetadataMock());
 *   seedAudioFile({ dir, relPath: "a.flac", metadata: { title: "A" } });
 *
 * `parseFile(path)` returns the metadata registered for `path`, or a sensible
 * default (no picture, empty common/format) when nothing is registered.
 */
import { vi } from "vitest";

import type { IAudioMetadata, IPicture } from "music-metadata";

export interface FixtureMetadata {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  trackNumber?: number;
  discNumber?: number;
  year?: number;
  duration?: number;
  bitrate?: number;
  codec?: string;
  bitsPerSample?: number;
  picture?: IPicture[];
}

const registry = new Map<string, IAudioMetadata>();

export function buildMetadata(fields: FixtureMetadata): IAudioMetadata {
  return {
    common: {
      title: fields.title,
      artist: fields.artist,
      album: fields.album,
      genre: fields.genre ? [fields.genre] : undefined,
      track: fields.trackNumber ? { no: fields.trackNumber, of: null } : undefined,
      disk: fields.discNumber ? { no: fields.discNumber, of: null } : undefined,
      year: fields.year,
      picture: fields.picture,
    },
    format: {
      duration: fields.duration,
      bitrate: fields.bitrate,
      codec: fields.codec,
      bitsPerSample: fields.bitsPerSample,
    },
  } as unknown as IAudioMetadata;
}

export function registerFixture(filePath: string, metadata: FixtureMetadata): void {
  registry.set(filePath, buildMetadata(metadata));
}

export function resetMusicMetadataMock(): void {
  registry.clear();
}

/**
 * Installs `vi.mock("music-metadata")` with a `parseFile` that consults the
 * shared registry. Call at module scope of the test file.
 */
export function installMusicMetadataMock(): void {
  vi.mock("music-metadata", () => ({
    parseFile: vi.fn(async (filePath: string) => {
      const hit = registry.get(filePath);
      if (hit) return hit;
      return {
        common: { picture: undefined },
        format: {},
      } as unknown as IAudioMetadata;
    }),
  }));
}
