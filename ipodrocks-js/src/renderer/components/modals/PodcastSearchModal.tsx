import { useState, useEffect, useRef } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import type { PodcastSearchResult } from "../../ipc/api";
import { usePodcastsStore } from "../../stores/podcasts-store";

interface PodcastSearchModalProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

export function PodcastSearchModal({
  open,
  onClose,
  onOpenSettings,
}: PodcastSearchModalProps) {
  const [term, setTerm] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { searchResults, searching, searchError, subscribedFeedIds, search, clearSearch, subscribe } =
    usePodcastsStore();
  const [subscribing, setSubscribing] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      clearSearch();
      setTerm("");
    }
  }, [open, clearSearch]);

  function handleTermChange(value: string) {
    setTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    debounceRef.current = setTimeout(() => {
      search(value);
    }, 300);
  }

  async function handleSubscribe(feed: PodcastSearchResult) {
    setSubscribing(feed.feedId);
    try {
      await subscribe(feed);
    } finally {
      setSubscribing(null);
    }
  }

  const showNoCredsError = searchError === "NO_CREDS";

  return (
    <Modal open={open} onClose={onClose} title="Search & Subscribe" width="max-w-2xl" closeOnBackdropClick>
      <div className="space-y-4">
        <Input
          label=""
          placeholder="Search for podcasts…"
          value={term}
          onChange={(e) => handleTermChange(e.target.value)}
          autoFocus
        />

        {showNoCredsError && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive flex items-center justify-between">
            <span>Podcast Index API credentials are not configured.</span>
            <Button size="sm" variant="danger" onClick={() => { onClose(); onOpenSettings(); }}>
              Open Settings
            </Button>
          </div>
        )}

        {searching && (
          <p className="text-sm text-muted-foreground text-center py-4">Searching…</p>
        )}

        {!searching && searchError && !showNoCredsError && (
          <p className="text-sm text-destructive text-center py-4">{searchError}</p>
        )}

        {!searching && !searchError && searchResults.length === 0 && term.trim() && (
          <p className="text-sm text-muted-foreground text-center py-4">No results found.</p>
        )}

        {!searching && searchResults.length > 0 && (
          <div className="space-y-2 overflow-y-auto max-h-[50vh]">
            {searchResults.map((result) => {
              const isSubscribed = subscribedFeedIds.has(result.feedId);
              return (
                <div
                  key={result.feedId}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/30 transition-colors"
                >
                  {result.imageUrl ? (
                    <img
                      src={result.imageUrl}
                      alt=""
                      className="w-12 h-12 rounded-md object-cover shrink-0"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center shrink-0">
                      <PodcastIcon className="w-6 h-6 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground truncate">{result.title}</p>
                    {result.author && (
                      <p className="text-xs text-muted-foreground truncate">{result.author}</p>
                    )}
                    {result.episodeCount > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {result.episodeCount} episode{result.episodeCount !== 1 ? "s" : ""}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={isSubscribed ? "secondary" : "primary"}
                    disabled={isSubscribed || subscribing === result.feedId}
                    onClick={() => !isSubscribed && handleSubscribe(result)}
                  >
                    {isSubscribed ? "✓ Subscribed" : subscribing === result.feedId ? "Adding…" : "+ Add"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

function PodcastIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M17.21,11.94C17.71,11.5 18,10.78 18,10A4,4 0 0,0 14,6A4,4 0 0,0 10,10C10,10.78 10.29,11.5 10.79,11.94C9.71,12.83 9,14.34 9,16A6,6 0 0,0 15,22V20A4,4 0 0,1 11,16C11,14.5 11.83,13.21 13,12.5V14H15V12.5C16.17,13.21 17,14.5 17,16A4,4 0 0,1 13,20V22A6,6 0 0,0 19,16C19,14.34 18.29,12.83 17.21,11.94Z" />
    </svg>
  );
}
