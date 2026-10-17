import { LOSSLESS_VERDICT_LABELS, type LosslessVerdict } from "@shared/types";

const SHORT: Record<LosslessVerdict, string> = {
  lossy_strong: "Lossy ●●",
  lossy: "Lossy ●",
  upsampled: "Upsampled",
  possibly_lossy: "Possibly",
  genuine: "✓",
  inconclusive: "?",
};

const TONE: Record<LosslessVerdict, string> = {
  lossy_strong: "bg-destructive/15 text-destructive font-semibold",
  lossy: "bg-destructive/10 text-destructive",
  upsampled: "bg-warning/15 text-warning",
  possibly_lossy: "bg-warning/10 text-warning",
  genuine: "text-success",
  inconclusive: "text-muted-foreground",
};

export function losslessTooltip(
  verdict: LosslessVerdict,
  opts: { cutoffHz?: number | null; source?: string | null; confidence?: number | null; override?: boolean }
): string {
  const parts = [LOSSLESS_VERDICT_LABELS[verdict]];
  if (opts.override) parts.push("marked OK by you");
  if (verdict !== "genuine" && verdict !== "inconclusive") {
    if (opts.cutoffHz) parts.push(`cutoff ${(opts.cutoffHz / 1000).toFixed(1)} kHz`);
    if (opts.source) parts.push(`likely ${opts.source}`);
  }
  if (opts.confidence != null && verdict !== "inconclusive") parts.push(`${Math.round(opts.confidence * 100)}% confidence`);
  return parts.join(" · ");
}

/** The verdict, compactly: the Library column and the check's results table. */
export function LosslessBadge({
  verdict,
  override = false,
  full = false,
  title,
}: {
  verdict: LosslessVerdict;
  override?: boolean;
  /** Full label instead of the short column form. */
  full?: boolean;
  title?: string;
}) {
  if (override) {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] text-muted-foreground border border-border" title={title}>
        OK (you)
      </span>
    );
  }
  return (
    <span
      className={`inline-flex px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap ${TONE[verdict]}`}
      title={title}
      data-verdict={verdict}
    >
      {full ? LOSSLESS_VERDICT_LABELS[verdict] : SHORT[verdict]}
    </span>
  );
}
