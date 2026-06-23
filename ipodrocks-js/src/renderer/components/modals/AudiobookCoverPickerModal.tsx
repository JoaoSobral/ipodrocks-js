import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { audiobookSearchCoverCandidates } from "../../ipc/api";
import { useAudiobooksStore } from "../../stores/audiobooks-store";
import type { CoverCandidate } from "@shared/types";
import type { AudiobookSubscription } from "../../ipc/api";

interface Props {
  open: boolean;
  subscription: AudiobookSubscription | null;
  onClose: () => void;
}

export function AudiobookCoverPickerModal({ open, subscription, onClose }: Props) {
  const { setCoverFromUrl } = useAudiobooksStore();
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CoverCandidate | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!open || !subscription) {
      setCandidates([]);
      setSelected(null);
      setCustomUrl("");
      return;
    }
    setLoading(true);
    audiobookSearchCoverCandidates(subscription.id)
      .then((results) => setCandidates(results))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [open, subscription]);

  async function handleApply() {
    if (!subscription) return;
    const url = customUrl.trim() || selected?.largeUrl;
    if (!url) return;

    setApplying(true);
    try {
      const ok = await setCoverFromUrl(subscription.id, url);
      if (ok) {
        toast.success("Cover updated");
        onClose();
      } else {
        toast.error("Failed to download cover", {
          description: "The image couldn't be fetched. Check the URL and try again.",
        });
      }
    } finally {
      setApplying(false);
    }
  }

  const hasSelection = !!customUrl.trim() || !!selected;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Find a Cover"
      width="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        {loading && (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            Searching Google Books &amp; Open Library…
          </div>
        )}

        {!loading && candidates.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No covers found automatically. Paste a direct image URL below.
          </p>
        )}

        {!loading && candidates.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              Click a cover to select it, then press <strong>Use selected</strong>.
            </p>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-72 overflow-y-auto pr-1">
              {candidates.map((c, i) => (
                <button
                  key={i}
                  onClick={() => { setSelected(c); setCustomUrl(""); }}
                  className={`relative flex flex-col rounded-lg overflow-hidden border-2 transition-all focus:outline-none ${
                    selected === c
                      ? "border-primary ring-2 ring-primary/30"
                      : "border-transparent hover:border-muted-foreground/40"
                  }`}
                  title={c.bookTitle}
                >
                  <img
                    src={c.thumbnailUrl}
                    alt={c.bookTitle}
                    className="w-full aspect-[2/3] object-cover bg-muted"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).closest("button")?.remove();
                    }}
                  />
                  <span className={`absolute bottom-0 left-0 right-0 text-[9px] px-1 py-0.5 text-center truncate ${
                    c.source === "google-books"
                      ? "bg-blue-600/80 text-white"
                      : "bg-orange-600/80 text-white"
                  }`}>
                    {c.source === "google-books" ? "Google" : "Open Library"}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Or paste a direct image URL
          </label>
          <input
            type="url"
            value={customUrl}
            onChange={(e) => { setCustomUrl(e.target.value); setSelected(null); }}
            placeholder="https://example.com/cover.jpg"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="flex justify-between items-center pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={!hasSelection || applying}
          >
            {applying ? "Downloading…" : "Use selected cover"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
