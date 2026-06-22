import { useEffect, useState } from "react";
import { Button } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { AudiobookSearchModal } from "../modals/AudiobookSearchModal";
import { AudiobookDetailModal } from "../modals/AudiobookDetailModal";
import { useAudiobooksStore } from "../../stores/audiobooks-store";
import type { AudiobookSubscription } from "../../ipc/api";

const PAGE_SIZE = 24;

function formatDuration(totalSeconds: number): string {
  if (!totalSeconds) return "";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AutoAudiobooksPanel() {
  const { subscriptions, loading, error, fetchSubs, applyCoverUpdate } = useAudiobooksStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
  const selectedSub: AudiobookSubscription | null =
    selectedSubId != null ? (subscriptions.find((s) => s.id === selectedSubId) ?? null) : null;
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchSubs();
  }, [fetchSubs]);

  // Covers download asynchronously after a book is added; swap the placeholder
  // for the real cover live when the main process reports it's ready.
  useEffect(() => {
    const off = window.api.on("audiobook:coverUpdated", (sub) => {
      applyCoverUpdate(sub as AudiobookSubscription);
    });
    return off;
  }, [applyCoverUpdate]);

  const totalPages = Math.ceil(subscriptions.length / PAGE_SIZE);
  const paginated = subscriptions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">
            {subscriptions.length} book{subscriptions.length !== 1 ? "s" : ""}
          </h3>
        </div>
        <Button variant="primary" size="sm" onClick={() => setSearchOpen(true)}>
          <span className="text-base leading-none">+</span> Search & Add
        </Button>
      </div>

      {/* Content */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      {!loading && !error && subscriptions.length === 0 && (
        <EmptyState
          icon="📚"
          title="No audiobooks yet"
          description='Click "Search & Add" to find free public-domain audiobooks from LibriVox. Added books appear in the Sync panel tagged "Extra" and chapters download automatically when you sync — no account required.'
          action={
            <Button variant="primary" size="sm" onClick={() => setSearchOpen(true)}>
              Search & Add
            </Button>
          }
        />
      )}

      {!loading && !error && subscriptions.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 flex-1 content-start overflow-y-auto">
            {paginated.map((sub) => (
              <button
                key={sub.id}
                onClick={() => setSelectedSubId(sub.id)}
                className="flex flex-col rounded-xl border border-border bg-card hover:bg-accent/30 transition-colors cursor-default overflow-hidden text-left"
              >
                <div className="relative w-full aspect-square bg-muted">
                  {sub.imageUrl ? (
                    <img
                      src={sub.imageUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <BookCoverIcon className="w-12 h-12 text-muted-foreground" />
                    </div>
                  )}
                </div>
                <div className="p-3 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{sub.title}</p>
                  {sub.author && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{sub.author}</p>
                  )}
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <span className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      Extra
                    </span>
                    {sub.numSections > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {sub.numSections} ch.
                      </span>
                    )}
                    {sub.totalSeconds > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatDuration(sub.totalSeconds)}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-4 shrink-0">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                ‹ Prev
              </Button>
              <span className="text-xs text-muted-foreground">
                {page + 1} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next ›
              </Button>
            </div>
          )}
        </>
      )}

      {/* Modals */}
      <AudiobookSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />

      <AudiobookDetailModal
        open={!!selectedSub}
        subscription={selectedSub}
        onClose={() => setSelectedSubId(null)}
      />
    </div>
  );
}

function BookCoverIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1M6 4h1v16H6zm13 16H9V4h10z" />
    </svg>
  );
}
