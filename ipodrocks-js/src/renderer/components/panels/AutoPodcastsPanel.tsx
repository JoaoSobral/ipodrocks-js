import { useEffect, useState } from "react";
import { Button } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { PodcastSearchModal } from "../modals/PodcastSearchModal";
import { PodcastEpisodeModal } from "../modals/PodcastEpisodeModal";
import { usePodcastsStore } from "../../stores/podcasts-store";
import { useUIStore } from "../../stores/ui-store";
import type { PodcastSubscription } from "../../ipc/api";

const PAGE_SIZE = 24;

function badgeLabel(sub: PodcastSubscription): string {
  if (sub.autoCount === 0) return "manual";
  return `last ${sub.autoCount}`;
}

export function AutoPodcastsPanel() {
  const { subscriptions, loading, error, fetchSubs } = usePodcastsStore();
  const openSettings = useUIStore((s) => s.openSettings);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
  const selectedSub = selectedSubId != null ? (subscriptions.find((s) => s.id === selectedSubId) ?? null) : null;
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchSubs();
  }, [fetchSubs]);

  const totalPages = Math.ceil(subscriptions.length / PAGE_SIZE);
  const paginated = subscriptions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 shrink-0">
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">
            {subscriptions.length} subscription{subscriptions.length !== 1 ? "s" : ""}
          </h3>
        </div>
        <Button variant="primary" size="sm" onClick={() => setSearchOpen(true)}>
          <span className="text-base leading-none">+</span> Search & Subscribe
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
          icon="🎙"
          title="No subscriptions yet"
          description='Click "Search & Subscribe" to find podcasts and start auto-downloading episodes to your devices.'
          action={
            <Button variant="primary" size="sm" onClick={() => setSearchOpen(true)}>
              Search & Subscribe
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
                <div className="relative w-full aspect-square">
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
                    <div className="w-full h-full bg-muted flex items-center justify-center">
                      <PodcastIcon className="w-10 h-10 text-muted-foreground" />
                    </div>
                  )}
                  {sub.isUpToDate && (
                    <span
                      className="absolute bottom-1.5 right-1.5 drop-shadow-sm"
                      title="Up to date — all target episodes downloaded"
                    >
                      <UpToDateIcon className="w-5 h-5 text-emerald-500" />
                    </span>
                  )}
                </div>
                <div className="p-3 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{sub.title}</p>
                  {sub.author && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{sub.author}</p>
                  )}
                  <span className="mt-2 inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {badgeLabel(sub)}
                  </span>
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
      <PodcastSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenSettings={() => openSettings?.()}
      />

      <PodcastEpisodeModal
        open={!!selectedSub}
        subscription={selectedSub}
        onClose={() => setSelectedSubId(null)}
      />
    </div>
  );
}

function PodcastIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M17.21,11.94C17.71,11.5 18,10.78 18,10A4,4 0 0,0 14,6A4,4 0 0,0 10,10C10,10.78 10.29,11.5 10.79,11.94C9.71,12.83 9,14.34 9,16A6,6 0 0,0 15,22V20A4,4 0 0,1 11,16C11,14.5 11.83,13.21 13,12.5V14H15V12.5C16.17,13.21 17,14.5 17,16A4,4 0 0,1 13,20V22A6,6 0 0,0 19,16C19,14.34 18.29,12.83 17.21,11.94Z" />
    </svg>
  );
}

function UpToDateIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M14 2a8 8 0 0 0-8 8a8 8 0 0 0 8 8a8 8 0 0 0 8-8a8 8 0 0 0-8-8M4.93 5.82A8.01 8.01 0 0 0 2 12a8 8 0 0 0 8 8c.64 0 1.27-.08 1.88-.23c-1.76-.39-3.38-1.27-4.71-2.48A6 6 0 0 1 4 12c0-.3.03-.59.07-.89C4.03 10.74 4 10.37 4 10c0-1.44.32-2.87.93-4.18m13.16.26L19.5 7.5L13 14l-3.79-3.79l1.42-1.42L13 11.17z" />
    </svg>
  );
}
