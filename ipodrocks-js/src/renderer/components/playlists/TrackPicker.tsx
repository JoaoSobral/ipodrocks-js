import { useEffect, useMemo, useRef, useState } from "react";
import { FixedSizeList as List } from "react-window";
import { Input, Select } from "../common";
import { TableHeader } from "../common/TableHeader";
import { Label } from "../common/Label";
import { Spinner } from "../common/Spinner";
import { formatDuration } from "../../utils/format";
import type { Track } from "../../ipc/api";

type SortField = "title" | "artist" | "album" | "genre" | "duration";
type SortDir = "asc" | "desc";

const columns: { field: SortField; label: string; width: string; minW: string }[] = [
  { field: "title", label: "Title", width: "flex-[3]", minW: "140px" },
  { field: "artist", label: "Artist", width: "flex-[2]", minW: "110px" },
  { field: "album", label: "Album", width: "flex-[2]", minW: "110px" },
  { field: "genre", label: "Genre", width: "w-24", minW: "80px" },
  { field: "duration", label: "Time", width: "w-16", minW: "56px" },
];

const ANY = "";

interface TrackPickerProps {
  /** Candidate tracks to pick from. Already filtered to music by the caller. */
  tracks: Track[];
  /** Ordered selection — index is the playlist position. Owned by the parent. */
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** Hard cap; once reached, unselected rows can no longer be ticked. */
  maxSelection: number;
  loading?: boolean;
}

/**
 * Virtualized multi-select track table used to hand-build a Classic playlist.
 *
 * The selection deliberately lives *outside* the filters: searching or
 * narrowing by artist/album/genre only changes which rows are visible, never
 * what is ticked. That's what lets the user assemble a playlist from several
 * different searches in one pass.
 */
export function TrackPicker({
  tracks,
  selectedIds,
  onChange,
  maxSelection,
  loading = false,
}: TrackPickerProps) {
  const [search, setSearch] = useState("");
  const [artistFilter, setArtistFilter] = useState(ANY);
  const [albumFilter, setAlbumFilter] = useState(ANY);
  const [genreFilter, setGenreFilter] = useState(ANY);
  const [sortField, setSortField] = useState<SortField>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const listContainerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(320);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setListHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // O(1) row lookup without forcing the parent to hold a second structure.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const atCapacity = selectedIds.length >= maxSelection;

  const uniqueSorted = (values: (string | undefined)[]) =>
    [...new Set(values.filter((v): v is string => !!v))].sort((a, b) =>
      a.localeCompare(b)
    );

  // Options come from the loaded tracks rather than a separate IPC call, so the
  // dropdowns can never offer a value the table has no row for.
  const artistOptions = useMemo(
    () => uniqueSorted(tracks.map((t) => t.artist)),
    [tracks]
  );
  const albumOptions = useMemo(
    () => uniqueSorted(tracks.map((t) => t.album)),
    [tracks]
  );
  const genreOptions = useMemo(
    () => uniqueSorted(tracks.map((t) => t.genre)),
    [tracks]
  );

  const filtered = useMemo(() => {
    let base = Array.isArray(tracks) ? tracks : [];

    // Partial, case-insensitive match across title + artist + album. Each
    // whitespace-separated term must appear somewhere in that combined text,
    // so "bowie heroes" finds the track even though no single field holds
    // both words.
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
      base = base.filter((t) => {
        const haystack = `${t.title} ${t.artist} ${t.album}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (artistFilter) base = base.filter((t) => t.artist === artistFilter);
    if (albumFilter) base = base.filter((t) => t.album === albumFilter);
    if (genreFilter) base = base.filter((t) => t.genre === genreFilter);

    return [...base].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "duration") return ((a.duration ?? 0) - (b.duration ?? 0)) * dir;
      return String(a[sortField] ?? "").localeCompare(String(b[sortField] ?? "")) * dir;
    });
  }, [tracks, search, artistFilter, albumFilter, genreFilter, sortField, sortDir]);

  function toggleSort(field: SortField) {
    if (field === sortField) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function sortArrow(field: SortField) {
    if (field !== sortField) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  function toggleTrack(id: number) {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((existing) => existing !== id));
    } else {
      if (atCapacity) return;
      onChange([...selectedIds, id]);
    }
  }

  /** Add as many of the currently visible rows as the cap still allows. */
  function selectAllFiltered() {
    const room = maxSelection - selectedIds.length;
    if (room <= 0) return;
    const additions = filtered
      .map((t) => t.id)
      .filter((id) => !selectedSet.has(id))
      .slice(0, room);
    if (additions.length > 0) onChange([...selectedIds, ...additions]);
  }

  const filtersActive =
    !!search.trim() || !!artistFilter || !!albumFilter || !!genreFilter;

  return (
    <div className="flex flex-col min-h-0 gap-2" data-testid="classic-track-picker">
      <Input
        placeholder="Search by title, artist, or album…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="classic-picker-search"
      />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex items-center gap-2">
          <Label className="mb-0 shrink-0">Artist:</Label>
          <Select
            options={[
              { value: ANY, label: "All" },
              ...artistOptions.map((a) => ({ value: a, label: a })),
            ]}
            value={artistFilter}
            onChange={setArtistFilter}
            placeholder="All"
            className="w-40"
            testId="classic-artist-filter"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="mb-0 shrink-0">Album:</Label>
          <Select
            options={[
              { value: ANY, label: "All" },
              ...albumOptions.map((a) => ({ value: a, label: a })),
            ]}
            value={albumFilter}
            onChange={setAlbumFilter}
            placeholder="All"
            className="w-40"
            testId="classic-album-filter"
          />
        </div>
        <div className="flex items-center gap-2">
          <Label className="mb-0 shrink-0">Genre:</Label>
          <Select
            options={[
              { value: ANY, label: "All" },
              ...genreOptions.map((g) => ({ value: g, label: g })),
            ]}
            value={genreFilter}
            onChange={setGenreFilter}
            placeholder="All"
            className="w-32"
            testId="classic-genre-filter"
          />
        </div>

        {filtersActive && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground underline cursor-pointer"
            onClick={() => {
              setSearch("");
              setArtistFilter(ANY);
              setAlbumFilter(ANY);
              setGenreFilter(ANY);
            }}
            data-testid="classic-reset-filters"
          >
            Reset filters
          </button>
        )}
      </div>

      {/* Table — horizontal scroll contained so it never pushes the modal wide */}
      <div
        ref={listContainerRef}
        className="flex-1 min-h-[240px] relative border border-border rounded-lg bg-card overflow-hidden"
      >
        <div className="absolute inset-0 overflow-auto">
          <div className="min-w-[620px]">
            <TableHeader sticky className="theme-box">
              <span className="w-8 shrink-0" aria-hidden="true" />
              {columns.map((col) => (
                <button
                  key={col.field}
                  type="button"
                  className={`${col.width} shrink-0 text-left cursor-default hover:text-muted-foreground transition-colors`}
                  style={{ minWidth: col.minW }}
                  onClick={() => toggleSort(col.field)}
                >
                  {col.label}
                  {sortArrow(col.field)}
                </button>
              ))}
            </TableHeader>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-8">
                {tracks.length === 0
                  ? "No music in your library yet — scan a folder first."
                  : "No songs match these filters"}
              </p>
            ) : (
              <List
                height={Math.max(listHeight - 33, 100)}
                itemCount={filtered.length}
                itemSize={32}
                width="100%"
                className="scrollbar-thin"
              >
                {({ index, style }) => {
                  const t = filtered[index];
                  const isSelected = selectedSet.has(t.id);
                  const isBlocked = !isSelected && atCapacity;
                  return (
                    <div
                      style={style}
                      data-testid={`classic-track-row-${t.id}`}
                      className={`flex items-center gap-2 px-2 py-1.5 text-xs border-b border-border transition-colors ${
                        isBlocked
                          ? "opacity-40 cursor-not-allowed"
                          : "cursor-pointer hover:bg-muted/30"
                      } ${isSelected ? "bg-primary/10" : ""}`}
                      title={
                        isBlocked
                          ? `Playlist is full (${maxSelection} songs)`
                          : "Click to select"
                      }
                      onClick={() => toggleTrack(t.id)}
                    >
                      <span className="w-8 shrink-0 flex items-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isBlocked}
                          onChange={() => toggleTrack(t.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select ${t.title}`}
                          className="accent-primary shrink-0"
                        />
                      </span>
                      <span
                        className="flex-[3] truncate text-foreground"
                        style={{ minWidth: "140px" }}
                      >
                        {t.title}
                      </span>
                      <span
                        className="flex-[2] truncate text-muted-foreground"
                        style={{ minWidth: "110px" }}
                      >
                        {t.artist}
                      </span>
                      <span
                        className="flex-[2] truncate text-muted-foreground"
                        style={{ minWidth: "110px" }}
                      >
                        {t.album}
                      </span>
                      <span className="w-24 min-w-[80px] truncate text-muted-foreground">
                        {t.genre}
                      </span>
                      <span className="w-16 min-w-[56px] text-muted-foreground tabular-nums">
                        {formatDuration(t.duration)}
                      </span>
                    </div>
                  );
                }}
              </List>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <span
          data-testid="classic-selection-count"
          className={atCapacity ? "text-warning font-medium" : "text-muted-foreground"}
        >
          {selectedIds.length} / {maxSelection} selected
        </span>
        {atCapacity && (
          <span className="text-warning text-[11px]">
            Playlist is full — untick a song to swap one in.
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            className="text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline cursor-pointer"
            onClick={selectAllFiltered}
            disabled={atCapacity || filtered.length === 0}
            data-testid="classic-select-all"
          >
            Select all shown
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground hover:underline disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            onClick={() => onChange([])}
            disabled={selectedIds.length === 0}
            data-testid="classic-clear"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
