/**
 * The album label used to identify an album in custom-sync selections.
 *
 * Issue #113: this label was previously built inline in five places (four in
 * SyncPanel, one in the main-process sync matcher) as `${album} — ${artist}`
 * using the *track* artist. A compilation whose tracks carry different artists
 * therefore produced one entry per track artist, and the selection list became
 * unusable. Grouping on the album artist collapses those back into one entry.
 *
 * Renderer and main process MUST agree on this format exactly — a mismatch makes
 * custom sync silently sync nothing — so it lives here as the single definition.
 */
import type { AlbumGrouping } from "./types";

/** Separator between album title and artist. An em dash, not a hyphen. */
const SEP = " — ";

export const UNKNOWN_ARTIST = "Unknown Artist";
export const UNKNOWN_ALBUM = "Unknown Album";

/** The minimal shape needed to derive an album label. */
export interface AlbumLabelSource {
  album?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
}

export function albumLabel(album: string, artist: string): string {
  return `${album.trim()}${SEP}${artist.trim()}`;
}

function albumOf(t: AlbumLabelSource): string {
  return String(t.album ?? UNKNOWN_ALBUM).trim() || UNKNOWN_ALBUM;
}

function trackArtistOf(t: AlbumLabelSource): string {
  return String(t.artist ?? UNKNOWN_ARTIST).trim() || UNKNOWN_ARTIST;
}

/** The album artist, falling back to the track artist when untagged. */
export function albumArtistOf(t: AlbumLabelSource): string {
  const aa = String(t.albumArtist ?? "").trim();
  return aa || trackArtistOf(t);
}

/** The single label a track contributes to the picker under `grouping`. */
export function albumLabelForTrack(
  t: AlbumLabelSource,
  grouping: AlbumGrouping
): string {
  const artist =
    grouping === "track-artist" ? trackArtistOf(t) : albumArtistOf(t);
  return albumLabel(albumOf(t), artist);
}

/**
 * Every label this track may legitimately be selected under: the label for the
 * active grouping plus the legacy track-artist label.
 *
 * Matching against all of these keeps selections saved before the album-artist
 * change working after an upgrade, so users do not silently lose their picks.
 */
export function albumLabelsForTrack(
  t: AlbumLabelSource,
  grouping: AlbumGrouping
): string[] {
  const album = albumOf(t);
  const labels = [albumLabel(album, albumArtistOf(t))];
  const legacy = albumLabel(album, trackArtistOf(t));
  if (grouping === "track-artist" || legacy !== labels[0]) labels.push(legacy);
  return labels;
}
