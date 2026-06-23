import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { useAudiobooksStore } from "../../stores/audiobooks-store";
import { AudiobookCoverPickerModal } from "./AudiobookCoverPickerModal";
import type { AudiobookSubscription } from "../../ipc/api";

interface Props {
  open: boolean;
  subscription: AudiobookSubscription | null;
  onClose: () => void;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const STATE_ICON: Record<string, string> = {
  ready: "✓",
  downloading: "…",
  failed: "✕",
  pending: "○",
  skipped: "−",
};

export function AudiobookDetailModal({ open, subscription, onClose }: Props) {
  const { chaptersBySub, fetchChapters, unsubscribe } = useAudiobooksStore();
  const chapters = subscription ? (chaptersBySub[subscription.id] ?? []) : [];
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (open && subscription) fetchChapters(subscription.id);
    if (!open) setPickerOpen(false);
  }, [open, subscription, fetchChapters]);

  async function handleUnsubscribe() {
    if (!subscription) return;
    await unsubscribe(subscription.id);
    onClose();
  }

  return (<>
    <Modal
      open={open}
      onClose={onClose}
      title={subscription?.title ?? ""}
      className="max-w-xl"
    >
      {subscription && (
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-start gap-3">
            <div className="w-16 h-16 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
              {subscription.imageUrl ? (
                <img
                  src={subscription.imageUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <BookIcon className="w-8 h-8 text-muted-foreground" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {subscription.author && (
                <p className="text-sm text-muted-foreground">{subscription.author}</p>
              )}
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {subscription.language && subscription.language !== "English" && (
                  <span className="text-xs text-muted-foreground">{subscription.language}</span>
                )}
                {subscription.numSections > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {subscription.numSections} chapter{subscription.numSections !== 1 ? "s" : ""}
                  </span>
                )}
                {subscription.totalSeconds > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(subscription.totalSeconds)}
                  </span>
                )}
              </div>
              {subscription.description && (
                <p className="text-xs text-muted-foreground mt-2 line-clamp-3">
                  {subscription.description}
                </p>
              )}
            </div>
          </div>

          <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
            Chapters download automatically when you sync this book to your device.
          </div>

          {/* Chapter list */}
          {chapters.length > 0 && (
            <div className="flex flex-col gap-0.5 max-h-[260px] overflow-y-auto">
              {chapters.map((ch) => (
                <div
                  key={ch.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/30"
                >
                  <span
                    className={`shrink-0 w-4 text-center font-mono ${
                      ch.downloadState === "ready"
                        ? "text-emerald-500"
                        : ch.downloadState === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    }`}
                    title={ch.downloadState}
                  >
                    {STATE_ICON[ch.downloadState] ?? "○"}
                  </span>
                  <span className="flex-1 truncate text-foreground">{ch.title}</span>
                  {ch.durationSeconds != null && (
                    <span className="shrink-0 text-muted-foreground">
                      {formatDuration(ch.durationSeconds)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {chapters.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No chapters loaded yet.
            </p>
          )}

          <div className="flex justify-between items-center pt-2 border-t border-border">
            <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>
              Search cover
            </Button>
            <Button variant="ghost" size="sm" onClick={handleUnsubscribe} className="text-destructive hover:text-destructive">
              Remove Book
            </Button>
          </div>
        </div>
      )}
    </Modal>

    <AudiobookCoverPickerModal
      open={pickerOpen}
      subscription={subscription}
      onClose={() => setPickerOpen(false)}
    />
  </> );
}

function BookIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1M6 4h1v16H6zm13 16H9V4h10z" />
    </svg>
  );
}
