/**
 * @vitest-environment node
 *
 * The lossless check's exports. Titles, albums and paths are whatever the
 * files were tagged with, so they carry commas, quotes, pipes and newlines;
 * a CSV or Markdown table that breaks on them silently shifts every column
 * after the bad cell.
 */
import { describe, expect, it } from "vitest";
import type { LosslessReportRow } from "../shared/types";
import { losslessReportCsv, losslessReportMarkdown } from "../renderer/utils/lossless-report";

const row: LosslessReportRow = {
  trackId: 1,
  title: 'Say "Hello", | Goodbye',
  artist: "Artist, The",
  album: "Line\nBreak | Album",
  path: "/music/a,b/c|d.flac",
  codec: "FLAC",
  verdict: "lossy_strong",
  confidence: 0.97,
  cutoffHz: 15400,
  source: "MP3 ~128 kbps",
  stage: "deep",
  cliffDb: 58,
  depthDb: 70,
  emptyShare: 1,
  override: false,
  checkedAt: null,
};

describe("lossless report exports", () => {
  it("CSV quotes every cell and doubles embedded quotes", () => {
    const csv = losslessReportCsv([row]);
    const header = csv.slice(0, csv.indexOf("\n"));
    // A quoted cell may legally hold a newline (the album here), so the record
    // is everything after the header, not one physical line.
    const line = csv.slice(csv.indexOf("\n") + 1);
    expect(line).toContain('"Line\nBreak | Album"');
    expect(header).toBe(
      '"title","artist","album","verdict","confidence","cutoff_hz","likely_source","marked_ok","codec","path"'
    );
    expect(line).toContain('"Say ""Hello"", | Goodbye"');
    expect(line).toContain('"Lossy-sourced (strong)","0.97","15400","MP3 ~128 kbps","no","FLAC","/music/a,b/c|d.flac"');
  });

  it("Markdown escapes pipes and flattens newlines so the row stays one row", () => {
    const md = losslessReportMarkdown([row], new Date("2026-10-18T10:00:00Z"));
    const tableRows = md.split("\n").filter((l) => l.startsWith("| Say"));
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0]).toContain("Say \"Hello\", \\| Goodbye");
    expect(tableRows[0]).toContain("Line Break \\| Album");
    expect(tableRows[0]).toContain("| 97% | 15.4 kHz | MP3 ~128 kbps |");
    expect(md).toContain("- **Lossy-sourced (strong)**: 1");
    expect(md).toContain("Generated 2026-10-18 10:00");
  });
});
