import type { LibrivoxSearchResult } from "../../shared/types";

let _baseUrl = "https://librivox.org";

export function setLibrivoxBaseUrl(url: string): void {
  _baseUrl = url;
}

interface LibrivoxAuthor {
  first_name: string;
  last_name: string;
}

interface LibrivoxBook {
  id: string;
  title: string;
  description: string;
  language: string;
  num_sections: string;
  totaltimesecs: string;
  url_rss: string;
  url_zip_file?: string;
  authors?: LibrivoxAuthor[];
}

interface LibrivoxResponse {
  books?: LibrivoxBook[];
  error?: string;
}

function buildAuthorName(authors?: LibrivoxAuthor[]): string | null {
  if (!authors || authors.length === 0) return null;
  const a = authors[0];
  const parts = [a.first_name, a.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function mapBook(b: LibrivoxBook): LibrivoxSearchResult {
  return {
    librivoxId: parseInt(b.id, 10),
    title: b.title,
    author: buildAuthorName(b.authors),
    description: b.description ? stripHtml(b.description) : null,
    imageUrl: null,
    rssUrl: b.url_rss,
    language: b.language || null,
    numSections: parseInt(b.num_sections, 10) || 0,
    totalSeconds: parseInt(b.totaltimesecs, 10) || 0,
  };
}

async function fetchBooks(params: Record<string, string>): Promise<LibrivoxBook[]> {
  const qs = new URLSearchParams({ format: "json", extended: "1", limit: "25", ...params }).toString();
  const url = `${_baseUrl}/api/feed/audiobooks?${qs}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "iPodRocks/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  // 404 + JSON error = "no results" (LibriVox API convention)
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`LibriVox API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as LibrivoxResponse;
  if (data.error) return []; // e.g. {"error":"Audiobooks could not be found"}
  return data.books ?? [];
}

export async function searchAudiobooks(term: string): Promise<LibrivoxSearchResult[]> {
  const t = term.trim();
  if (!t) return [];

  // LibriVox author search only matches on last name, so if the term has
  // multiple words (e.g. "Philip K. Dick") also try the last word as author.
  const words = t.split(/\s+/);
  const lastWord = words[words.length - 1].replace(/[.,]$/, "");
  const authorQueries = new Set([t, ...(words.length > 1 ? [lastWord] : [])]);

  const [byTitle, ...authorResults] = await Promise.all([
    fetchBooks({ title: t }),
    ...[...authorQueries].map((q) => fetchBooks({ author: q })),
  ]);

  // Deduplicate by ID, title results first
  const seen = new Set<number>();
  const merged: LibrivoxBook[] = [];
  for (const b of [byTitle, ...authorResults].flat()) {
    const id = parseInt(b.id, 10);
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(b);
    }
  }
  return merged.map(mapBook);
}
