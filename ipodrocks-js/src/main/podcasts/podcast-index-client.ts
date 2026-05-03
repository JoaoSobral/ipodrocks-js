import * as crypto from "crypto";
import type { PodcastSearchResult } from "../../shared/types";

const BASE_URL = "https://api.podcastindex.org/api/1.0";
const USER_AGENT = "iPodRocks/1.0";

function buildHeaders(apiKey: string, apiSecret: string): Record<string, string> {
  const authDate = Math.floor(Date.now() / 1000).toString();
  // Podcast Index API mandates SHA-1(apiKey + apiSecret + authDate) — not our choice.
  // lgtm[js/weak-cryptographic-algorithm, js/insufficient-password-hash]
  const hash = crypto
    .createHash("sha1")
    .update(apiKey + apiSecret + authDate)
    .digest("hex");

  return {
    "User-Agent": USER_AGENT,
    "X-Auth-Date": authDate,
    "X-Auth-Key": apiKey,
    Authorization: hash,
    Accept: "application/json",
  };
}

export async function searchPodcasts(
  term: string,
  apiKey: string,
  apiSecret: string
): Promise<PodcastSearchResult[]> {
  const url = `${BASE_URL}/search/byterm?q=${encodeURIComponent(term)}&max=50`;
  const res = await fetch(url, { headers: buildHeaders(apiKey, apiSecret) });

  if (!res.ok) {
    throw new Error(`Podcast Index search failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    feeds?: Array<{
      id: number;
      title?: string;
      author?: string;
      description?: string;
      image?: string;
      url?: string;
      episodeCount?: number;
    }>;
  };

  return (data.feeds ?? []).map((f) => ({
    feedId: f.id,
    title: f.title ?? "",
    author: f.author ?? "",
    description: f.description ?? "",
    imageUrl: f.image ?? "",
    feedUrl: f.url ?? "",
    episodeCount: f.episodeCount ?? 0,
  }));
}

export interface PodcastIndexEpisode {
  guid: string;
  title: string;
  description: string;
  enclosureUrl: string;
  enclosureLength: number;
  duration: number;
  datePublished: number;
  feedId: number;
}

export async function getEpisodes(
  feedId: number,
  max: number,
  apiKey: string,
  apiSecret: string
): Promise<PodcastIndexEpisode[]> {
  const url = `${BASE_URL}/episodes/byfeedid?id=${feedId}&max=${max}&fulltext=false`;
  const res = await fetch(url, { headers: buildHeaders(apiKey, apiSecret) });

  if (!res.ok) {
    throw new Error(`Podcast Index episodes failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    items?: Array<{
      guid?: string;
      title?: string;
      description?: string;
      enclosureUrl?: string;
      enclosureLength?: number;
      duration?: number;
      datePublished?: number;
      feedId?: number;
    }>;
  };

  return (data.items ?? []).map((item) => ({
    guid: item.guid ?? "",
    title: item.title ?? "",
    description: item.description ?? "",
    enclosureUrl: item.enclosureUrl ?? "",
    enclosureLength: item.enclosureLength ?? 0,
    duration: item.duration ?? 0,
    datePublished: item.datePublished ?? 0,
    feedId: item.feedId ?? feedId,
  }));
}
