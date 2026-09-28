import { XMLParser, type EntityDecoderOptions } from "fast-xml-parser";
import type Database from "better-sqlite3";
import type { FeedCandidate, PodcastFeedPreview } from "../../shared/types";
import { subscribeRssFeed } from "./podcast-subscriptions";
import { safeFetch } from "../utils/safe-fetch";
import { readBodyCapped } from "../utils/capped-stream";
import type { PodcastSubscription } from "../../shared/types";

const UA = "iPodRocks/1.0";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Size ceilings on what a feed URL may send us, counted in *decoded* bytes.
 *
 * The body is buffered and then parsed synchronously on the only thread the
 * daemon has, so its size is the cost of the call for every other user of the
 * server — and `Content-Encoding` means the wire size bounds nothing. A feed is
 * rejected past the cap (a real one with a long back catalogue runs to a few
 * MB; 16 MiB leaves room for the largest). A web page is truncated instead:
 * discovery only wants the `<link>` tags in its `<head>`.
 */
export const MAX_FEED_BYTES = 16 * 1024 * 1024;
export const MAX_DISCOVERY_HTML_BYTES = 1024 * 1024;

// ---- Input classification ----

const RSS_EXTENSIONS = /\.(xml|rss)(\?.*)?$/i;
const RSS_PATH_PATTERNS = /\/(feed|rss|podcast\.xml|feed\.xml|rss\.xml)(\/|$|\?)/i;
const RSS_QUERY_PATTERNS = /[?&]format=(rss|xml)/i;
const COMMON_FEED_PATHS = ["/feed", "/rss", "/podcast.xml", "/feed.xml", "/rss.xml", "/feed/podcast"];

export type InputKind = "rss" | "website";

export function classifyInput(raw: string): InputKind {
  const u = raw.trim();
  if (RSS_EXTENSIONS.test(u) || RSS_PATH_PATTERNS.test(u) || RSS_QUERY_PATTERNS.test(u)) {
    return "rss";
  }
  return "website";
}

// ---- Feed discovery ----

async function fetchText(
  url: string,
  maxBytes: number,
  onOverflow: "reject" | "truncate"
): Promise<{ text: string; finalUrl: string }> {
  // The URL came from the caller and the response is reflected back to them,
  // so this is a read primitive aimed from the server's network position.
  const res = await safeFetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const bytes = await readBodyCapped(res.body, maxBytes, onOverflow);
  // `TextDecoder` is what `res.text()` used: UTF-8, BOM stripped, lenient.
  return { text: new TextDecoder().decode(bytes), finalUrl: res.url };
}

async function probeIsFeed(url: string): Promise<boolean> {
  try {
    const res = await safeFetch(url, {
      method: "HEAD",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(8_000),
    });
    const ct = res.headers.get("content-type") ?? "";
    return res.ok && /xml|rss|atom/i.test(ct);
  } catch {
    return false;
  }
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// ---- <link> scanning ----
//
// This used to be two regexes, `/<link([^>]*)>/gi` over the page and
// `/(\w[\w-]*)=["']([^"']*)["']/g` over each tag. Both are unanchored with a
// greedy loop the engine backtracks through, so each is quadratic: a body of
// `<link` repeated with no `>` rescans to the end from every occurrence, and one
// `<link aaaa…>` tag retries `[\w-]*` from every start position. V8's regex
// engine backtracks; a 1 MB page from the caller's own server held the
// daemon's thread for minutes. What follows is a hand-written scan whose every
// loop only moves forward, so the cost is linear in the page whatever it holds.

/** A `<link>` longer than this is not a feed link; it is skipped unread. */
const MAX_LINK_TAG_LENGTH = 8 * 1024;

function isTagNameEnd(code: number): boolean {
  // whitespace, "/" or ">" — so `<linkfoo` is not a `<link`.
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
    || code === 0x2f || code === 0x3e || Number.isNaN(code);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

/** Separates attributes: whitespace, or the `/` of a self-closing `<link … />`. */
function isAttrSeparator(ch: string): boolean {
  return isSpace(ch) || ch === "/";
}

/** Attributes of one tag's content (between `<link` and `>`), names lowercased. */
export function extractLinkAttributes(tagContent: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const n = tagContent.length;
  let i = 0;
  while (i < n) {
    while (i < n && isAttrSeparator(tagContent[i])) i++;
    const nameStart = i;
    while (i < n && !isAttrSeparator(tagContent[i]) && tagContent[i] !== "=") i++;
    const name = tagContent.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(tagContent[i])) i++;
    let value = "";
    if (tagContent[i] === "=") {
      i++;
      while (i < n && isSpace(tagContent[i])) i++;
      const q = tagContent[i];
      if (q === '"' || q === "'") {
        const close = tagContent.indexOf(q, i + 1);
        const end = close === -1 ? n : close;
        value = tagContent.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(tagContent[i])) i++;
        value = tagContent.slice(valueStart, i);
      }
    }
    if (name && !(name in attrs)) attrs[name] = value;
    if (i === nameStart) i++; // a lone "=" — step over it
  }
  return attrs;
}

/** The content of every `<link …>` tag in `html`, in one forward pass. */
export function findLinkTags(html: string): string[] {
  const tags: string[] = [];
  let from = 0;
  // The `>` found for an earlier `<link`, reused while it is still ahead of us:
  // re-searching from every occurrence is exactly the quadratic case.
  let gt = -1;
  for (;;) {
    // Not `html.toLowerCase().indexOf("<link")`: lowercasing can change a
    // string's length ("İ" becomes two code units), and the offsets must be
    // offsets into `html`.
    const start = html.indexOf("<", from);
    if (start === -1) break;
    const contentStart = start + 5;
    if (
      html.slice(start + 1, contentStart).toLowerCase() !== "link" ||
      !isTagNameEnd(html.charCodeAt(contentStart))
    ) {
      from = start + 1;
      continue;
    }
    if (gt < contentStart) gt = html.indexOf(">", contentStart);
    if (gt === -1) break; // no `>` anywhere after this: no further tag can close
    if (gt - contentStart <= MAX_LINK_TAG_LENGTH) {
      tags.push(html.slice(contentStart, gt));
      from = gt + 1;
    } else {
      from = contentStart;
    }
  }
  return tags;
}

async function discoverFromHtml(html: string, baseUrl: string): Promise<FeedCandidate[]> {
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();

  for (const tag of findLinkTags(html)) {
    const attrs = extractLinkAttributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase();
    const type = attrs.type ?? "";
    if (
      (rel.includes("alternate") || rel.includes("feed")) &&
      /rss\+xml|atom\+xml/i.test(type) &&
      attrs.href
    ) {
      const resolved = resolveUrl(attrs.href, baseUrl);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        candidates.push({ feedUrl: resolved, title: attrs.title ?? null });
      }
    }
  }

  if (candidates.length === 0) {
    const origin = new URL(baseUrl).origin;
    await Promise.all(
      COMMON_FEED_PATHS.map(async (p) => {
        const url = origin + p;
        if (!seen.has(url) && (await probeIsFeed(url))) {
          seen.add(url);
          candidates.push({ feedUrl: url, title: null });
        }
      })
    );
  }

  return candidates;
}

export async function discoverFeeds(input: string): Promise<FeedCandidate[]> {
  const kind = classifyInput(input);
  if (kind === "rss") {
    return [{ feedUrl: input.trim(), title: null }];
  }
  const { text: html, finalUrl } = await fetchText(input.trim(), MAX_DISCOVERY_HTML_BYTES, "truncate");
  return discoverFromHtml(html, finalUrl);
}

// ---- RSS parsing ----

export interface ParsedEpisode {
  guid: string;
  title: string;
  description: string;
  enclosureUrl: string;
  enclosureLength: number;
  durationSeconds: number;
  publishedAt: number; // unix seconds
}

export interface ParsedFeed {
  feedUrl: string;
  title: string;
  author: string | null;
  description: string | null;
  imageUrl: string | null;
  episodes: ParsedEpisode[];
}

function parseDuration(val: string | number | undefined): number {
  if (val === undefined || val === null) return 0;
  if (typeof val === "number") return Math.round(val);
  const s = String(val).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(":").map(Number);
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  if (parts.length === 2) return (parts[0] * 60) + parts[1];
  return 0;
}

function parseDate(val: string | undefined): number {
  if (!val) return 0;
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

/**
 * The entity decoder the feed parser uses: the five XML predefined entities,
 * and nothing a document can declare.
 *
 * A feed is somebody else's XML. With the parser's default decoder, a
 * `<!DOCTYPE>` internal subset defines entities that are expanded inside
 * every text node that names them — one large value referenced thousands of
 * times is gigabytes of string from a body of a megabyte. `processEntities:
 * false` would stop that, but it also stops `&amp;` in a title decoding, which
 * every real feed relies on. So entity processing stays on and this decoder
 * simply ignores `addInputEntities()`: a declared entity is left as the literal
 * text `&name;`. CDATA is never passed through `decode()` by the parser, so it
 * stays verbatim exactly as before. Numeric references were not decoded by
 * the default decoder either (it only does so with `htmlEntities`), and are
 * left alone here to match.
 */
const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};
const PREDEFINED_ENTITY_RE = /&(amp|lt|gt|quot|apos);/g;

export const feedEntityDecoder: EntityDecoderOptions = {
  setExternalEntities: () => undefined,
  addInputEntities: () => undefined,
  reset: () => undefined,
  setXmlVersion: () => undefined,
  decode: (text) =>
    text.indexOf("&") === -1
      ? text
      : text.replace(PREDEFINED_ENTITY_RE, (_m, name: string) => PREDEFINED_ENTITIES[name]),
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => name === "item",
  entityDecoder: feedEntityDecoder,
});

export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  // Rejected, not truncated, past the cap: half a feed parses as a different feed.
  const { text: xml } = await fetchText(feedUrl, MAX_FEED_BYTES, "reject");
  let parsed: Record<string, unknown>;
  try {
    parsed = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error("Not a valid XML feed");
  }

  const rss = parsed.rss as Record<string, unknown> | undefined;
  const feed = parsed.feed as Record<string, unknown> | undefined; // Atom fallback

  let channel: Record<string, unknown>;
  if (rss?.channel) {
    channel = rss.channel as Record<string, unknown>;
  } else if (feed) {
    channel = feed;
  } else {
    throw new Error("Not a valid podcast feed (no channel or feed element)");
  }

  const title = String(
    (channel.title as string | undefined) ??
    (channel["itunes:title"] as string | undefined) ??
    ""
  ).trim();
  if (!title) throw new Error("Feed has no title");

  const description = String(
    (channel.description as string | undefined) ??
    (channel["itunes:summary"] as string | undefined) ??
    (channel.subtitle as string | undefined) ??
    ""
  ).trim() || null;

  const author =
    String(
      (channel["itunes:author"] as string | undefined) ??
      (channel.managingEditor as string | undefined) ??
      (channel.author as string | undefined) ??
      ""
    ).trim() || null;

  const imageObj = channel.image as Record<string, unknown> | undefined;
  const itunesImg = channel["itunes:image"] as Record<string, unknown> | string | undefined;
  let imageUrl: string | null = null;
  if (typeof imageObj?.url === "string") imageUrl = imageObj.url.trim() || null;
  if (!imageUrl && typeof itunesImg === "object" && itunesImg !== null) {
    imageUrl = String((itunesImg as Record<string, unknown>)["@_href"] ?? "").trim() || null;
  }
  if (!imageUrl && typeof itunesImg === "string") imageUrl = itunesImg.trim() || null;

  const rawItems = (channel.item as unknown[]) ?? [];
  const episodes: ParsedEpisode[] = [];

  for (const raw of rawItems) {
    const item = raw as Record<string, unknown>;
    const enc = item.enclosure as Record<string, unknown> | undefined;
    const enclosureUrl =
      String((enc?.["@_url"] as string | undefined) ?? "").trim();
    if (!enclosureUrl) continue;

    const guid =
      String(
        typeof item.guid === "object" && item.guid !== null
          ? (item.guid as Record<string, unknown>)["#text"] ?? enclosureUrl
          : (item.guid as string | undefined) ?? enclosureUrl
      ).trim();

    const epTitle = String(
      (item.title as string | undefined) ??
      (item["itunes:title"] as string | undefined) ??
      "Untitled"
    ).trim();

    const epDesc = String(
      (item["itunes:summary"] as string | undefined) ??
      (item.description as string | undefined) ??
      (item["content:encoded"] as string | undefined) ??
      ""
    ).trim();

    const durationSeconds = parseDuration(
      (item["itunes:duration"] as string | number | undefined)
    );

    const publishedAt = parseDate(
      (item.pubDate as string | undefined) ??
      (item.published as string | undefined)
    );

    const enclosureLength = parseInt(
      String((enc?.["@_length"] as string | undefined) ?? "0"),
      10
    ) || 0;

    episodes.push({ guid, title: epTitle, description: epDesc, enclosureUrl, enclosureLength, durationSeconds, publishedAt });
  }

  return { feedUrl, title, author, description, imageUrl, episodes };
}

export function feedPreview(parsed: ParsedFeed): PodcastFeedPreview {
  return {
    feedUrl: parsed.feedUrl,
    title: parsed.title,
    author: parsed.author,
    description: parsed.description,
    imageUrl: parsed.imageUrl,
    episodeCount: parsed.episodes.length,
  };
}

// ---- One-shot import (used by IPC handler + assistant tool) ----

export async function importFeed(
  db: Database.Database,
  input: string
): Promise<PodcastSubscription> {
  const candidates = await discoverFeeds(input);
  if (candidates.length === 0) {
    throw new Error("No RSS feed found at that URL. Make sure it is a valid podcast website or RSS feed.");
  }
  const parsed = await fetchAndParseFeed(candidates[0].feedUrl);
  return subscribeRssFeed(db, parsed);
}

