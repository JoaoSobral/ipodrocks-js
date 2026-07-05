import { XMLParser } from "fast-xml-parser";
import type Database from "better-sqlite3";
import type { FeedCandidate, PodcastFeedPreview } from "../../shared/types";
import { subscribeRssFeed } from "./podcast-subscriptions";
import type { PodcastSubscription } from "../../shared/types";

const UA = "iPodRocks/1.0";
const FETCH_TIMEOUT_MS = 15_000;

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

async function fetchText(url: string): Promise<{ text: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return { text: await res.text(), finalUrl: res.url };
}

async function probeIsFeed(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
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

const LINK_TAG_RE = /<link([^>]*)>/gi;
const ATTR_RE = /(\w[\w-]*)=["']([^"']*)["']/g;

function extractLinkAttributes(tagContent: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tagContent)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

async function discoverFromHtml(html: string, baseUrl: string): Promise<FeedCandidate[]> {
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  LINK_TAG_RE.lastIndex = 0;
  while ((m = LINK_TAG_RE.exec(html)) !== null) {
    const attrs = extractLinkAttributes(m[1]);
    const rel = attrs.rel ?? "";
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
  const { text: html, finalUrl } = await fetchText(input.trim());
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

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => name === "item",
});

export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  const { text: xml } = await fetchText(feedUrl);
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

