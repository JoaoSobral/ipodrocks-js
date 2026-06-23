import { useState, useEffect, useRef } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { useAudiobooksStore } from "../../stores/audiobooks-store";
import type { LibrivoxSearchResult } from "../../ipc/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatDuration(totalSeconds: number): string {
  if (!totalSeconds) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AudiobookSearchModal({ open, onClose }: Props) {
  const { searchResults, searching, searchError, subscribedIds, search, clearSearch, subscribe } =
    useAudiobooksStore();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      clearSearch();
    }
  }, [open, clearSearch]);

  function handleQueryChange(val: string) {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (val.trim()) search(val);
      else clearSearch();
    }, 350);
  }

  async function handleAdd(result: LibrivoxSearchResult) {
    setAdding(result.librivoxId);
    try {
      await subscribe(result);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Search LibriVox Audiobooks" className="max-w-xl">
      <div className="flex flex-col gap-4">
        <input
          type="text"
          placeholder="Search by title…"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoFocus
        />

        {searching && (
          <p className="text-sm text-muted-foreground text-center py-4">Searching…</p>
        )}

        {!searching && searchError && (
          <p className="text-sm text-destructive text-center py-4">{searchError}</p>
        )}

        {!searching && !searchError && searchResults.length === 0 && query.trim() && (
          <p className="text-sm text-muted-foreground text-center py-4">No results found.</p>
        )}

        {!searching && searchResults.length > 0 && (
          <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-1">
            {searchResults.map((r) => {
              const alreadyAdded = subscribedIds.has(r.librivoxId);
              const isAdding = adding === r.librivoxId;
              return (
                <div
                  key={r.librivoxId}
                  className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card"
                >
                  <div className="w-10 h-10 shrink-0 bg-muted rounded flex items-center justify-center">
                    <BookIcon className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{r.title}</p>
                    {r.author && (
                      <p className="text-xs text-muted-foreground truncate">{r.author}</p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {r.numSections > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {r.numSections} chapter{r.numSections !== 1 ? "s" : ""}
                        </span>
                      )}
                      {r.totalSeconds > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {formatDuration(r.totalSeconds)}
                        </span>
                      )}
                      {r.language && r.language !== "English" && (
                        <span className="text-[10px] text-muted-foreground">{r.language}</span>
                      )}
                    </div>
                  </div>
                  <Button
                    variant={alreadyAdded ? "ghost" : "primary"}
                    size="sm"
                    disabled={alreadyAdded || isAdding}
                    onClick={() => handleAdd(r)}
                    className="shrink-0"
                  >
                    {alreadyAdded ? "Added" : isAdding ? "Adding…" : "Add"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {!query.trim() && !searching && searchResults.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            Search for public-domain audiobooks from LibriVox — no account required.
          </p>
        )}
      </div>
    </Modal>
  );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1M6 4h1v16H6zm13 16H9V4h10z" />
    </svg>
  );
}
