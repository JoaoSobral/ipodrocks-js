/**
 * Rocksy's access to the full user documentation.
 *
 * `appDocs.ts` is a hand-kept summary that rides in every system prompt; the
 * docs themselves are ~170 KB, far too much to send on every turn. This is the
 * rest: every page under docs/, bundled by `scripts/bundle-docs.js`, searched
 * by section so a how-to or troubleshooting question gets the paragraph that
 * answers it rather than a guess from the summary.
 *
 * Plain keyword scoring, deliberately. The corpus is a few dozen pages, the
 * questions name features ("rockbox database", "shadow library", "tagnavi"),
 * and a result the model can read in full is worth more than a clever rank.
 */

import { DOCS_PAGES, type DocsPage } from "./docsCorpus.generated";

export interface DocsSection {
  page: string;
  pageTitle: string;
  heading: string;
  text: string;
}

/** A section returned whole up to this; longer ones are cut with a pointer to the page. */
const SECTION_CHARS = 4000;
/** A page returned whole up to this. */
const PAGE_CHARS = 24_000;

let sectionsCache: DocsSection[] | null = null;

/** Each page split at its `##`/`###` headings; the text before the first is the intro. */
function sections(): DocsSection[] {
  if (sectionsCache) return sectionsCache;
  const out: DocsSection[] = [];
  for (const page of DOCS_PAGES) {
    let heading = page.title;
    let lines: string[] = [];
    const flush = () => {
      const text = lines.join("\n").trim();
      if (text) out.push({ page: page.path, pageTitle: page.title, heading, text });
    };
    let inFence = false;
    for (const line of page.content.split("\n")) {
      if (line.startsWith("```")) inFence = !inFence;
      const m = !inFence && /^#{2,3}\s+(.+)$/.exec(line);
      if (m) {
        flush();
        heading = m[1].trim();
        lines = [line];
      } else {
        lines.push(line);
      }
    }
    flush();
  }
  sectionsCache = out;
  return out;
}

const STOP_WORDS = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or the to what when where which why with you your".split(
    " "
  )
);

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The best-matching sections for a free-text question. */
export function searchDocs(query: string, limit = 5): DocsSection[] {
  const ts = terms(query);
  if (ts.length === 0) return [];
  const phrase = query.trim().toLowerCase();
  const scored = sections()
    .map((s) => {
      const body = s.text.toLowerCase();
      const head = `${s.pageTitle} ${s.heading}`.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of ts) {
        const inBody = countOf(body, t);
        const inHead = countOf(head, t);
        if (inBody || inHead) matched++;
        score += Math.min(inBody, 8) + inHead * 6;
      }
      // Every term present beats many hits on one; the exact phrase beats both.
      score *= matched / ts.length;
      if (phrase.length > 3 && body.includes(phrase)) score += 15;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ s }) => ({
    ...s,
    text:
      s.text.length > SECTION_CHARS
        ? `${s.text.slice(0, SECTION_CHARS)}\n… (section continues — read the page "${s.page}")`
        : s.text,
  }));
}

/** One page by its docs path, tolerant of a missing ".md" or a leading "docs/". */
export function readDocsPage(pagePath: string): DocsPage | null {
  const want = pagePath.trim().replace(/^\/+/, "").replace(/^docs\//, "").toLowerCase();
  const page =
    DOCS_PAGES.find((p) => p.path.toLowerCase() === want) ??
    DOCS_PAGES.find((p) => p.path.toLowerCase() === `${want}.md`) ??
    null;
  if (!page) return null;
  return page.content.length > PAGE_CHARS
    ? { ...page, content: `${page.content.slice(0, PAGE_CHARS)}\n… (page truncated)` }
    : page;
}

/** Every page, for orientation. */
export function listDocsPages(): Array<{ path: string; title: string }> {
  return DOCS_PAGES.map((p) => ({ path: p.path, title: p.title }));
}
