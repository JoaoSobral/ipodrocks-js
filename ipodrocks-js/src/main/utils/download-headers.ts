/**
 * Standard request headers for downloading media enclosures (podcast episodes,
 * audiobook chapters, cover art) from arbitrary podcast CDNs.
 *
 * Node's global `fetch` (undici) sends `Accept-Language: *` by default. Some
 * CDNs that do geo/language-targeted dynamic ad insertion — notably Captivate
 * (`episodes.captivate.fm` → `dax.captivate.fm`) — reject the wildcard with a
 * 404 instead of redirecting to the stitched file. Sending a concrete
 * `Accept-Language` keeps these hosts happy while staying harmless elsewhere.
 */
export const DOWNLOAD_HEADERS: Record<string, string> = {
  "User-Agent": "iPodRocks/1.0",
  "Accept-Language": "en-US,en;q=0.9",
};
