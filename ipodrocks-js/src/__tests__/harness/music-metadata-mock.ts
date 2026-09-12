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
  albumArtist?: string;
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
  /**
   * A file-embedded rating, on music-metadata's normalized 0..1 scale — the
   * same shape `common.rating[].rating` carries for ID3 POPM, Vorbis
   * `RATING` comments, etc. (see metadata-extractor.ts's
   * `ratingFromCommonTags`). Omit to simulate a file with no rating tag.
   */
  rating?: number;
  /**
   * ReplayGain, in the shape music-metadata hands back after `toRatio()`:
   * gains carry `dB`, peaks carry `ratio`. Without this every fixture parsed
   * as "this file has no ReplayGain", which is why the shadow-library
   * transcode path had no ReplayGain coverage at all when issue #130 shipped.
   */
  replayGain?: {
    trackGainDb?: number;
    trackPeakRatio?: number;
    albumGainDb?: number;
    albumPeakRatio?: number;
  };
}

const registry = new Map<string, IAudioMetadata>();

export function buildMetadata(fields: FixtureMetadata): IAudioMetadata {
  return {
    common: {
      title: fields.title,
      artist: fields.artist,
      albumartist: fields.albumArtist,
      album: fields.album,
      genre: fields.genre ? [fields.genre] : undefined,
      track: fields.trackNumber ? { no: fields.trackNumber, of: null } : undefined,
      disk: fields.discNumber ? { no: fields.discNumber, of: null } : undefined,
      year: fields.year,
      picture: fields.picture,
      rating:
        fields.rating !== undefined ? [{ rating: fields.rating }] : undefined,
      replaygain_track_gain:
        fields.replayGain?.trackGainDb !== undefined
          ? { dB: fields.replayGain.trackGainDb, ratio: 0 }
          : undefined,
      replaygain_track_peak:
        fields.replayGain?.trackPeakRatio !== undefined
          ? { dB: 0, ratio: fields.replayGain.trackPeakRatio }
          : undefined,
      replaygain_album_gain:
        fields.replayGain?.albumGainDb !== undefined
          ? { dB: fields.replayGain.albumGainDb, ratio: 0 }
          : undefined,
      replaygain_album_peak:
        fields.replayGain?.albumPeakRatio !== undefined
          ? { dB: 0, ratio: fields.replayGain.albumPeakRatio }
          : undefined,
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
 * Whether `parseFile` should answer from the registry or from the real parser.
 *
 * The `vi.mock` below has to sit at module top level — vitest hoists it there
 * regardless, and since v5 it refuses to run when written inside a function.
 * But this module is re-exported from `harness/index.ts`, so merely importing
 * any harness helper evaluates it, and half the suites that do that want the
 * *real* music-metadata. So the mock is always registered and defaults to
 * delegating; `installMusicMetadataMock()` is what switches it over.
 *
 * Note this replaces `parseFile` only. Everything else the module exports —
 * `parseBuffer`, which the MPC branch of `MetadataExtractor` uses — stays real
 * even in a mocked test, where it used to be absent entirely.
 */
let useRegistry = false;

/**
 * Answer `parseFile` from the shared registry instead of reading the file.
 * Call at module scope of the test file, as before.
 */
export function installMusicMetadataMock(): void {
  useRegistry = true;
}

vi.mock("music-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("music-metadata")>();
  return {
    ...actual,
    parseFile: vi.fn(async (filePath: string, ...rest: unknown[]) => {
      if (!useRegistry) {
        return (actual.parseFile as (...a: unknown[]) => Promise<IAudioMetadata>)(
          filePath,
          ...rest
        );
      }
      const hit = registry.get(filePath);
      if (hit) return hit;
      return {
        common: { picture: undefined },
        format: {},
      } as unknown as IAudioMetadata;
    }),
  };
});
