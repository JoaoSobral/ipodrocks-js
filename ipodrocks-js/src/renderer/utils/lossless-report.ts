import { LOSSLESS_VERDICT_LABELS, type LosslessReportRow } from "@shared/types";
import { toCsv } from "./download";

export function formatCutoff(hz: number | null): string {
  return hz == null ? "" : `${(hz / 1000).toFixed(1)} kHz`;
}

export function formatConfidence(c: number | null): string {
  return c == null ? "" : `${Math.round(c * 100)}%`;
}

export function losslessReportCsv(rows: LosslessReportRow[]): string {
  return toCsv([
    ["title", "artist", "album", "verdict", "confidence", "cutoff_hz", "likely_source", "marked_ok", "codec", "path"],
    ...rows.map((r) => [
      r.title,
      r.artist,
      r.album,
      LOSSLESS_VERDICT_LABELS[r.verdict],
      r.confidence == null ? "" : r.confidence.toFixed(2),
      r.cutoffHz,
      r.source,
      r.override ? "yes" : "no",
      r.codec,
      r.path,
    ]),
  ]);
}

/** Markdown table cells: pipes and newlines would break the row. */
function md(text: string | number | null | undefined): string {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function losslessReportMarkdown(rows: LosslessReportRow[], generatedAt = new Date()): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  const lines = [
    "# iPodRocks — Lossless Check report",
    "",
    `Generated ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} · ${rows.length} track(s)`,
    "",
    "Verdicts describe what the audio shows — a lossy encoder's frequency cutoff — not where the file came from.",
    "",
    ...[...counts].map(([v, n]) => `- **${LOSSLESS_VERDICT_LABELS[v as keyof typeof LOSSLESS_VERDICT_LABELS]}**: ${n}`),
    "",
    "| Title | Artist | Album | Verdict | Confidence | Cutoff | Likely source | Path |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${md(r.title)} | ${md(r.artist)} | ${md(r.album)} | ${md(LOSSLESS_VERDICT_LABELS[r.verdict])}${r.override ? " (marked OK)" : ""} | ${formatConfidence(r.confidence)} | ${formatCutoff(r.cutoffHz)} | ${md(r.source)} | \`${String(r.path).replace(/`/g, "'")}\` |`
    ),
    "",
  ];
  return lines.join("\n");
}
