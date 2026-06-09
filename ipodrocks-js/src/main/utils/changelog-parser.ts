/**
 * Extracts the body of the `## [<version>]` section from a CHANGELOG.md
 * formatted in the Keep-a-Changelog style.
 *
 * The section ends at whichever comes first: the next `## [` heading or a
 * standalone `---` horizontal rule. The returned string excludes both the
 * heading itself and the trailing separator/heading.
 *
 * Returns `null` when the version isn't found.
 */
export function extractChangelogSection(
  markdown: string,
  version: string
): string | null {
  const lines = markdown.split(/\r?\n/);
  // Match `## [<version>]` allowing optional trailing date text like `— 2026-05`.
  const headingRegex = new RegExp(
    `^## \\[${version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\](.*)$`
  );

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^## \[/.test(line) || /^---\s*$/.test(line)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}
