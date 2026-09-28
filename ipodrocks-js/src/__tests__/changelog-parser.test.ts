/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { extractChangelogSection, isChangelogVersion } from "../main/utils/changelog-parser";

const FIXTURE = `# Changelog

## [1.3.5] — 2026-06

### Bug fixes

- **Sync engine fix** — Tracks now copy.
- **Another fix** — More words.

### Testing

- Added tests.

---

## [1.3.4] — 2026-05

### Bug fixes

- **macOS sidecar files** ([#77](https://example/issues/77)) — long body.

---

## [1.1.3.1] — 2026-04-19

### Documentation

- Shadow library notes.

---
`;

describe("extractChangelogSection", () => {
  it("returns the section body for a known version", () => {
    const section = extractChangelogSection(FIXTURE, "1.3.5");
    expect(section).not.toBeNull();
    expect(section).toContain("### Bug fixes");
    expect(section).toContain("**Sync engine fix**");
    expect(section).toContain("### Testing");
  });

  it("excludes the version heading and trailing separator", () => {
    const section = extractChangelogSection(FIXTURE, "1.3.5")!;
    expect(section.startsWith("## [")).toBe(false);
    expect(section.endsWith("---")).toBe(false);
    expect(section).not.toContain("## [1.3.4]");
  });

  it("stops at the next version heading and does not bleed into it", () => {
    const section = extractChangelogSection(FIXTURE, "1.3.5")!;
    expect(section).not.toContain("macOS sidecar files");
  });

  it("returns null when the version is absent", () => {
    expect(extractChangelogSection(FIXTURE, "9.9.9")).toBeNull();
  });

  it("handles four-segment versions like 1.1.3.1", () => {
    const section = extractChangelogSection(FIXTURE, "1.1.3.1");
    expect(section).not.toBeNull();
    expect(section).toContain("Shadow library notes");
  });

  it("does not match 1.3 when asked for 1.3.5 (no prefix matching)", () => {
    const partial = `## [1.3] — old\n\nold content\n\n---\n\n## [1.3.5] — new\n\nnew content\n`;
    const section = extractChangelogSection(partial, "1.3.5");
    expect(section).toContain("new content");
    expect(section).not.toContain("old content");
  });

  it("treats the version as text, never as regex syntax (ReDoS)", () => {
    // The old escaper was inert, so this became `^## \[x\]|(.+)+y\](.*)$` and
    // backtracked for ever on a long line — on the daemon's one event loop.
    const longLine = "a".repeat(5000);
    const md = `${FIXTURE}\n${longLine}\n`;
    const t0 = Date.now();
    expect(extractChangelogSection(md, "x]|(.+)+y")).toBeNull();
    expect(extractChangelogSection(md, "(.+)+y")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    // `.` is literal: 1x3x5 must not match the 1.3.5 heading.
    expect(extractChangelogSection(FIXTURE, "1x3x5")).toBeNull();
  });
});

describe("isChangelogVersion", () => {
  it("admits release-shaped versions", () => {
    for (const v of ["1.3.5", "v3.0.0", "1.1.3.1", "2.3.0-beta", "2.3.0-beta.1", "3"]) {
      expect(isChangelogVersion(v)).toBe(true);
    }
  });

  it("refuses anything else before the changelog is touched", () => {
    for (const v of ["", "x]|(.+)+y", "1.3.5]", "1..3", "1.2.3.4.5", " 1.2", "1.2-", null, 3, {}]) {
      expect(isChangelogVersion(v)).toBe(false);
    }
    expect(isChangelogVersion("1." + "1".repeat(80))).toBe(false);
  });
});
