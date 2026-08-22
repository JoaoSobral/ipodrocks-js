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

/** A picker entry: its stable key plus the parts needed to display it. */
export interface AlbumEntry {
  /** Selection key — byte-identical to `albumLabelForTrack`. Persisted; never change. */
  key: string;
  album: string;
  artist: string;
}

/**
 * The picker entry a track contributes under `grouping`.
 *
 * `key` MUST equal `albumLabelForTrack(t, grouping)`: it is what gets written to
 * `custom_selections_json` and what the main-process matcher compares against.
 * Display text is derived separately by {@link buildAlbumDisplayMap}, so the
 * two can diverge without breaking a single saved selection.
 */
export function albumEntryForTrack(
  t: AlbumLabelSource,
  grouping: AlbumGrouping
): AlbumEntry {
  const album = albumOf(t);
  const artist =
    grouping === "track-artist" ? trackArtistOf(t) : albumArtistOf(t);
  return { key: albumLabel(album, artist), album, artist };
}

/**
 * Map each entry key to the text shown for it.
 *
 * Album titles carry the meaning, so a row reads as just the album name. The
 * artist is appended only when it is doing real work — two different albums
 * sharing a title, e.g. "Greatest Hits" by ABBA and by Queen — which would
 * otherwise be two identical, unpickable rows.
 */
export function buildAlbumDisplayMap(
  entries: AlbumEntry[]
): Map<string, string> {
  // Count DISTINCT keys per title: a compilation contributes one entry per
  // track, and those duplicates must not make a unique album look ambiguous.
  const keysByAlbum = new Map<string, Set<string>>();
  for (const e of entries) {
    const set = keysByAlbum.get(e.album) ?? new Set<string>();
    set.add(e.key);
    keysByAlbum.set(e.album, set);
  }

  const display = new Map<string, string>();
  for (const e of entries) {
    const ambiguous = (keysByAlbum.get(e.album)?.size ?? 0) > 1;
    display.set(e.key, ambiguous ? albumLabel(e.album, e.artist) : e.album);
  }
  return display;
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
