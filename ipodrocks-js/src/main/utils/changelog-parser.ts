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
  //
  // **A plain prefix comparison, never a RegExp built from `version`.** The
  // version arrives over `app:fetchChangelogSection` from any web client, and
  // the escaper this used to run was inert (`[\\]` closed the class early), so
  // `x]|(.+)+y` became live regex syntax that backtracked for ever on a long
  // changelog line — on the daemon's one event loop. The closing `]` is part of
  // the prefix, which is what keeps `1.3` from matching `1.3.5`.
  const heading = `## [${version}]`;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(heading)) {
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

const CHANGELOG_VERSION = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.]+)?$/;

/**
 * True for a release-shaped version (`1.3.5`, `v3.0.0`, `2.3.0-beta.1`).
 * `app:fetchChangelogSection` refuses anything else before it touches the
 * changelog: the handler is reachable by every web client, and nothing a real
 * release is called needs more than this.
 */
export function isChangelogVersion(version: unknown): version is string {
  return typeof version === "string" && version.length <= 64 && CHANGELOG_VERSION.test(version);
}
