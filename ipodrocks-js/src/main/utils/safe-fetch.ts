import * as dns from "dns/promises";
import * as net from "net";

/**
 * `fetch` for a URL a client chose.
 *
 * Several handlers take a URL straight from the request — podcast feed
 * discovery and preview, `audiobook:setCoverFromUrl`, the `podcast_add_by_url`
 * tool — and the daemon's network position is not the caller's. On a NAS or in
 * a container that position reaches loopback services, RFC1918 neighbours and
 * cloud metadata endpoints the caller cannot otherwise touch, and the feed
 * preview *reflects the response back*, which turns it from a blind request
 * into a read primitive.
 *
 * Three rules, and the third is the one that is easy to forget:
 *
 * 1. Only `http:` and `https:`. `file:`, `data:` and the rest are not
 *    transports a remote feed can legitimately live on.
 * 2. The host must not resolve to a loopback, private, link-local, unique-local
 *    or otherwise non-public address.
 * 3. **Every redirect hop is re-checked.** Following redirects automatically is
 *    what makes rule 2 decorative: a public host that 302s to `127.0.0.1` walks
 *    straight past a check applied only to the first URL.
 *
 * This does not close DNS rebinding — the name is resolved here and again by
 * the connect — which is a known limit of doing it in userland rather than
 * pinning the socket to the vetted address. It closes the direct and
 * redirect-based cases, which are the reachable ones.
 */

const MAX_REDIRECTS = 5;

/**
 * The escape hatch, off by default.
 *
 * A self-hosted user may genuinely keep a feed on their own LAN, and refusing
 * that outright would be the guard deciding their network for them. It is
 * opt-in rather than opt-out because the reason the guard exists is that on a
 * shared server the person supplying the URL is not the person who owns the
 * network the daemon sits on.
 */
let allowPrivate = process.env.IPODROCKS_ALLOW_PRIVATE_FETCH === "1";

/** Test seam and the runtime switch behind `IPODROCKS_ALLOW_PRIVATE_FETCH`. */
export function setPrivateFetchAllowed(allowed: boolean): boolean {
  const previous = allowPrivate;
  allowPrivate = allowed;
  return previous;
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function isBlockedIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const s = ip.toLowerCase().split("%")[0];
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb"))
    return true; // link-local
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // unique-local
  if (s.startsWith("ff")) return true; // multicast
  // IPv4-mapped / -compatible: judge the embedded v4 address.
  const m = s.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isBlockedIpv4(m[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedIpv4(ip);
  if (v === 6) return isBlockedIpv6(ip);
  return true;
}

/** Throws {@link BlockedUrlError} unless this URL is a public http(s) target. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(`Refusing to fetch a non-public address: ${host}`);
    }
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedUrlError(`Refusing to fetch a non-public address: ${host}`);
  }
  return u;
}

/**
 * Fetches a client-supplied URL, validating the target and every redirect hop.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit = {}
): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status > 399) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new BlockedUrlError(`Too many redirects starting at ${raw}`);
}
