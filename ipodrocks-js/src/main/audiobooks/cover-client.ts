let _googleBooksBase = "https://www.googleapis.com";
let _openLibraryBase = "https://openlibrary.org";
let _openLibraryCoversBase = "https://covers.openlibrary.org";

export function setCoverApiBaseUrls(opts: {
  googleBooks?: string;
  openLibrary?: string;
  openLibraryCovers?: string;
}): void {
  if (opts.googleBooks !== undefined) _googleBooksBase = opts.googleBooks;
  if (opts.openLibrary !== undefined) _openLibraryBase = opts.openLibrary;
  if (opts.openLibraryCovers !== undefined) _openLibraryCoversBase = opts.openLibraryCovers;
}

/**
 * Upgrades Google's `http:` cover links to `https:`, but leaves loopback hosts
 * untouched so local stub servers (used in E2E tests) keep working over http.
 */
function preferHttps(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
      return url;
    }
  } catch {
    /* not a parseable URL — fall through to the upgrade */
  }
  return url.replace(/^http:/, "https:");
}

async function tryGoogleBooks(title: string, author: string | null): Promise<string | null> {
  try {
    const q = author
      ? `intitle:"${title}"+inauthor:"${author}"`
      : `intitle:"${title}"`;
    const url = `${_googleBooksBase}/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ volumeInfo: { imageLinks?: Record<string, string> } }>;
    };
    const links = data.items?.[0]?.volumeInfo?.imageLinks;
    if (!links) return null;
    for (const key of ["extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"]) {
      if (links[key]) {
        return preferHttps(links[key]).replace("&edge=curl", "");
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function tryOpenLibrary(title: string, author: string | null): Promise<string | null> {
  try {
    const params = new URLSearchParams({ limit: "1", title });
    if (author) params.set("author", author);
    const url = `${_openLibraryBase}/search.json?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { docs?: Array<{ cover_i?: number }> };
    const coverId = data.docs?.[0]?.cover_i;
    if (!coverId) return null;
    return `${_openLibraryCoversBase}/b/id/${coverId}-L.jpg`;
  } catch {
    return null;
  }
}

/** Resolves a single best cover image URL (used for automatic on-add fetch). */
export async function resolveCoverUrl(title: string, author: string | null): Promise<string | null> {
  const gb = await tryGoogleBooks(title, author);
  if (gb) return gb;
  return tryOpenLibrary(title, author);
}

// ---------------------------------------------------------------------------
// Multi-candidate search for the interactive picker
// ---------------------------------------------------------------------------

import type { CoverCandidate } from "../../shared/types";

async function googleBooksCandidates(title: string, author: string | null): Promise<CoverCandidate[]> {
  try {
    const q = author ? `intitle:"${title}"+inauthor:"${author}"` : `intitle:"${title}"`;
    const url = `${_googleBooksBase}/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8`;
    const res = await fetch(url, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: Array<{ volumeInfo: { title?: string; imageLinks?: Record<string, string> } }>;
    };
    const candidates: CoverCandidate[] = [];
    for (const item of data.items ?? []) {
      const links = item.volumeInfo.imageLinks;
      if (!links) continue;
      const thumb =
        links.thumbnail ?? links.smallThumbnail ?? links.small ?? links.medium ?? null;
      const large =
        links.extraLarge ?? links.large ?? links.medium ?? links.small ?? thumb ?? null;
      if (!thumb || !large) continue;
      candidates.push({
        thumbnailUrl: preferHttps(thumb).replace("&edge=curl", ""),
        largeUrl: preferHttps(large).replace("&edge=curl", ""),
        bookTitle: item.volumeInfo.title ?? title,
        source: "google-books",
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

async function openLibraryCandidates(title: string, author: string | null): Promise<CoverCandidate[]> {
  try {
    const params = new URLSearchParams({ limit: "8", title });
    if (author) params.set("author", author);
    const url = `${_openLibraryBase}/search.json?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "iPodRocks/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      docs?: Array<{ title?: string; cover_i?: number }>;
    };
    const candidates: CoverCandidate[] = [];
    for (const doc of data.docs ?? []) {
      if (!doc.cover_i) continue;
      candidates.push({
        thumbnailUrl: `${_openLibraryCoversBase}/b/id/${doc.cover_i}-M.jpg`,
        largeUrl: `${_openLibraryCoversBase}/b/id/${doc.cover_i}-L.jpg`,
        bookTitle: doc.title ?? title,
        source: "open-library",
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

/** Returns up to ~10 cover candidates from both sources for the interactive picker. */
export async function searchCoverCandidates(
  title: string,
  author: string | null
): Promise<CoverCandidate[]> {
  const [gb, ol] = await Promise.all([
    googleBooksCandidates(title, author),
    openLibraryCandidates(title, author),
  ]);
  // Interleave sources so the picker isn't all-Google or all-OL
  const merged: CoverCandidate[] = [];
  const max = Math.max(gb.length, ol.length);
  for (let i = 0; i < max; i++) {
    if (gb[i]) merged.push(gb[i]);
    if (ol[i]) merged.push(ol[i]);
  }
  return merged.slice(0, 12);
}
