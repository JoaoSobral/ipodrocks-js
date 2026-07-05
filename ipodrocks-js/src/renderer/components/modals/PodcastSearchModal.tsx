import { useState, useEffect, useRef } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import type { PodcastSearchResult, FeedCandidate, PodcastFeedPreview } from "../../ipc/api";
import { usePodcastsStore, podcastDiscoverFeeds, podcastPreviewFeed } from "../../stores/podcasts-store";

interface PodcastSearchModalProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

type Tab = "search" | "url";

// ---- Search tab (existing flow) ----

function SearchTab({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const [term, setTerm] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { searchResults, searching, searchError, subscribedFeedIds, search, clearSearch, subscribe } =
    usePodcastsStore();
  const [subscribing, setSubscribing] = useState<number | null>(null);

  useEffect(() => () => { clearSearch(); }, [clearSearch]);

  function handleTermChange(value: string) {
    setTerm(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) { clearSearch(); return; }
    debounceRef.current = setTimeout(() => search(value), 300);
  }

  async function handleSubscribe(feed: PodcastSearchResult) {
    setSubscribing(feed.feedId);
    try { await subscribe(feed); } finally { setSubscribing(null); }
  }

  const showNoCredsError = searchError === "NO_CREDS";

  return (
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
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
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
  );
}

// ---- Add by URL tab ----

type UrlPhase =
  | { kind: "idle" }
  | { kind: "discovering" }
  | { kind: "selecting"; candidates: FeedCandidate[] }
  | { kind: "previewing"; feedUrl: string }
  | { kind: "preview"; preview: PodcastFeedPreview }
  | { kind: "subscribing"; preview: PodcastFeedPreview }
  | { kind: "done"; title: string }
  | { kind: "error"; message: string };

function UrlTab() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<UrlPhase>({ kind: "idle" });
  const { subscribeByUrl } = usePodcastsStore();

  function reset() { setPhase({ kind: "idle" }); setUrl(""); }

  async function handleFind() {
    const raw = url.trim();
    if (!raw) return;
    setPhase({ kind: "discovering" });
    try {
      const candidates = await podcastDiscoverFeeds(raw);
      if (candidates.length === 0) {
        setPhase({ kind: "error", message: "No RSS feed found at that URL. Try pasting the RSS feed URL directly." });
        return;
      }
      if (candidates.length === 1) {
        await loadPreview(candidates[0].feedUrl);
      } else {
        setPhase({ kind: "selecting", candidates });
      }
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  async function loadPreview(feedUrl: string) {
    setPhase({ kind: "previewing", feedUrl });
    try {
      const result = await podcastPreviewFeed(feedUrl);
      if ("error" in result) {
        setPhase({ kind: "error", message: result.error });
      } else {
        setPhase({ kind: "preview", preview: result });
      }
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  async function handleSubscribe(feedUrl: string, preview: PodcastFeedPreview) {
    setPhase({ kind: "subscribing", preview });
    try {
      await subscribeByUrl(feedUrl);
      setPhase({ kind: "done", title: preview.title });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  const busy = phase.kind === "discovering" || phase.kind === "previewing" || phase.kind === "subscribing";

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          label=""
          placeholder="Paste RSS feed or podcast website URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && handleFind()}
          autoFocus
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleFind}
          disabled={!url.trim() || busy}
        >
          {phase.kind === "discovering" ? "Finding…" : "Find"}
        </Button>
      </div>

      {phase.kind === "discovering" && (
        <p className="text-sm text-muted-foreground text-center py-4">Detecting feed…</p>
      )}

      {phase.kind === "selecting" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Multiple feeds found — select one:</p>
          {phase.candidates.map((c) => (
            <button
              key={c.feedUrl}
              onClick={() => loadPreview(c.feedUrl)}
              className="w-full text-left p-3 rounded-lg border border-border hover:bg-accent/30 transition-colors"
            >
              <p className="text-sm font-medium text-foreground truncate">{c.title ?? c.feedUrl}</p>
              {c.title && <p className="text-xs text-muted-foreground truncate">{c.feedUrl}</p>}
            </button>
          ))}
        </div>
      )}

      {phase.kind === "previewing" && (
        <p className="text-sm text-muted-foreground text-center py-4">Loading feed…</p>
      )}

      {(phase.kind === "preview" || phase.kind === "subscribing") && (
        <div className="flex items-start gap-4 p-4 rounded-xl border border-border bg-card">
          <div className="w-20 h-20 rounded-lg overflow-hidden shrink-0 bg-muted flex items-center justify-center">
            {phase.preview.imageUrl ? (
              <img
                src={phase.preview.imageUrl}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <PodcastIcon className="w-8 h-8 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{phase.preview.title}</p>
            {phase.preview.author && <p className="text-xs text-muted-foreground mt-0.5">{phase.preview.author}</p>}
            {phase.preview.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{phase.preview.description}</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              {phase.preview.episodeCount} episode{phase.preview.episodeCount !== 1 ? "s" : ""}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={phase.kind === "subscribing"}
                onClick={() => handleSubscribe(phase.preview.feedUrl, phase.preview)}
              >
                {phase.kind === "subscribing" ? "Subscribing…" : "+ Subscribe"}
              </Button>
              <Button size="sm" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3 text-sm text-emerald-600 dark:text-emerald-400 flex items-center justify-between">
          <span>✓ Subscribed to <strong>{phase.title}</strong></span>
          <Button size="sm" variant="ghost" onClick={reset}>Add another</Button>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive flex items-center justify-between">
          <span>{phase.message}</span>
          <Button size="sm" variant="ghost" onClick={() => setPhase({ kind: "idle" })}>Dismiss</Button>
        </div>
      )}
    </div>
  );
}

// ---- Main modal ----

export function PodcastSearchModal({
  open,
  onClose,
  onOpenSettings,
}: PodcastSearchModalProps) {
  const [tab, setTab] = useState<Tab>("search");

  useEffect(() => {
    if (!open) setTab("search");
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Search & Subscribe" width="max-w-2xl" closeOnBackdropClick>
      {/* Tab header */}
      <div className="flex gap-1 mb-4 border-b border-border -mt-1">
        {(["search", "url"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ${
              tab === t
                ? "border border-b-card border-border bg-card text-foreground -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "search" ? "Search" : "Add by URL"}
          </button>
        ))}
      </div>

      {tab === "search" && <SearchTab onClose={onClose} onOpenSettings={onOpenSettings} />}
      {tab === "url" && <UrlTab />}
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
