import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import type { PodcastSubscription, PodcastEpisode } from "../../ipc/api";
import { usePodcastsStore } from "../../stores/podcasts-store";

interface PodcastEpisodeModalProps {
  open: boolean;
  subscription: PodcastSubscription | null;
  onClose: () => void;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function stateIcon(state: PodcastEpisode["downloadState"]): string {
  switch (state) {
    case "ready": return "✓";
    case "downloading": return "…";
    case "failed": return "✕";
    case "skipped": return "−";
    default: return "·";
  }
}

export function PodcastEpisodeModal({
  open,
  subscription,
  onClose,
}: PodcastEpisodeModalProps) {
  const {
    episodesBySub,
    fetchEpisodes,
    setAutoCount,
    setManualSelection,
    downloadNow,
    unsubscribe,
  } = usePodcastsStore();

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [manualSelected, setManualSelected] = useState<Set<number>>(new Set());

  const subId = subscription?.id ?? -1;
  const episodes: PodcastEpisode[] = subId >= 0 ? (episodesBySub[subId] ?? []) : [];
  const isManual = subscription?.autoCount === 0;

  useEffect(() => {
    if (open && subId >= 0) {
      fetchEpisodes(subId);
    }
  }, [open, subId, fetchEpisodes]);

  useEffect(() => {
    if (open && subscription) {
      setManualSelected(
        new Set(episodes.filter((e) => e.manualSelected).map((e) => e.id))
      );
      setDownloadError(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subscription?.id]);

  async function handleAutoCountChange(value: string) {
    if (!subscription) return;
    await setAutoCount(subscription.id, parseInt(value, 10));
  }


  async function handleToggleManual(epId: number) {
    const next = new Set(manualSelected);
    if (next.has(epId)) {
      next.delete(epId);
    } else {
      if (next.size >= 5) return;
      next.add(epId);
    }
    setManualSelected(next);
    await setManualSelection(subId, [...next]);
  }

  async function handleDownloadNow() {
    setDownloading(true);
    setDownloadError(null);
    const result = await downloadNow(subId);
    setDownloading(false);
    if ("error" in result) {
      setDownloadError(result.error ?? "Download failed");
    }
  }

  async function handleUnsubscribe() {
    if (!subscription) return;
    await unsubscribe(subscription.id);
    onClose();
  }

  if (!subscription) return null;

  const autoCountOptions = [
    { value: "1", label: "Last 1 episode" },
    { value: "2", label: "Last 2 episodes" },
    { value: "3", label: "Last 3 episodes" },
    { value: "4", label: "Last 4 episodes" },
    { value: "5", label: "Last 5 episodes" },
    { value: "0", label: "Manual selection" },
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={subscription.title}
      width="max-w-2xl"
      closeOnBackdropClick
    >
      <div className="space-y-4">
        {/* Artwork + author */}
        <div className="flex items-center gap-4">
          {subscription.imageUrl ? (
            <img
              src={subscription.imageUrl}
              alt=""
              className="w-16 h-16 rounded-lg object-cover shrink-0"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <PodcastIcon className="w-8 h-8 text-muted-foreground" />
            </div>
          )}
          {subscription.author && (
            <p className="text-sm text-muted-foreground">{subscription.author}</p>
          )}
        </div>

        {/* Auto count or manual */}
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Select
              label="Auto-download"
              tooltip="In auto mode, iPodRocks keeps the latest episodes ready. A buffer of up to 10 episodes is stored — when a new episode is downloaded and the total exceeds 10, the oldest episode is deleted to make room."
              value={String(subscription.autoCount)}
              onChange={handleAutoCountChange}
              options={autoCountOptions}
            />
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={downloading}
            onClick={handleDownloadNow}
          >
            {downloading ? "Downloading…" : "Download now"}
          </Button>
        </div>

        {isManual && (
          <p className="text-xs text-muted-foreground">
            Select up to 5 episodes to download (checked = selected).
          </p>
        )}

        {downloadError && (
          <p className="text-xs text-destructive">{downloadError}</p>
        )}

        {/* Episode list */}
        <div className="space-y-1 overflow-y-auto max-h-[40vh]">
          {episodes.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">
              No episodes yet. Click "Download now" to refresh.
            </p>
          )}
          {episodes.map((ep) => (
            <div
              key={ep.id}
              className={`flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                isManual ? "cursor-default hover:bg-accent/30" : ""
              }`}
              onClick={() => isManual && handleToggleManual(ep.id)}
            >
              {isManual && (
                <input
                  type="checkbox"
                  checked={manualSelected.has(ep.id)}
                  onChange={() => handleToggleManual(ep.id)}
                  disabled={!manualSelected.has(ep.id) && manualSelected.size >= 5}
                  className="mt-0.5 shrink-0 accent-primary"
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground truncate">{ep.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(ep.publishedAt)}
                  {ep.durationSeconds ? ` · ${formatDuration(ep.durationSeconds)}` : ""}
                </p>
              </div>
              <span
                className={`text-xs shrink-0 mt-0.5 ${
                  ep.downloadState === "ready"
                    ? "text-success"
                    : ep.downloadState === "failed"
                    ? "text-destructive"
                    : ep.downloadState === "downloading"
                    ? "text-primary"
                    : "text-muted-foreground"
                }`}
                title={ep.downloadError ?? ep.downloadState}
              >
                {stateIcon(ep.downloadState)}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center pt-2 border-t border-border">
          <Button size="sm" variant="danger" onClick={handleUnsubscribe}>
            Unsubscribe
          </Button>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
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
