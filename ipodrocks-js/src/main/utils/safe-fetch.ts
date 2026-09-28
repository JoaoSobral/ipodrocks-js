import * as dns from "dns/promises";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as zlib from "zlib";
import { Readable, pipeline, type Transform } from "stream";

/**
 * `fetch` for a URL a client chose.
 *
 * Several handlers take a URL straight from the request — podcast feed
 * discovery and preview, `audiobook:setCoverFromUrl`, the `podcast_add_by_url`
 * tool, and every enclosure URL inside a feed someone subscribed to — and the
 * daemon's network position is not the caller's. On a NAS or in a container
 * that position reaches loopback services, RFC1918 neighbours and cloud
 * metadata endpoints the caller cannot otherwise touch, and the feed preview
 * *reflects the response back*, which turns it from a blind request into a read
 * primitive.
 *
 * Four rules, and the last two are the ones that are easy to forget:
 *
 * 1. Only `http:` and `https:`. `file:`, `data:` and the rest are not
 *    transports a remote feed can legitimately live on.
 * 2. The host must not resolve to a loopback, private, link-local, unique-local
 *    or otherwise non-public address — judged on the *parsed* address, never
 *    its spelling. The WHATWG URL parser serialises `[::ffff:127.0.0.1]` as
 *    `::ffff:7f00:1`, so a textual check on the dotted form let every
 *    IPv4-mapped literal straight through.
 * 3. **Every redirect hop is re-checked.** Following redirects automatically is
 *    what makes rule 2 decorative: a public host that 302s to `127.0.0.1` walks
 *    straight past a check applied only to the first URL.
 * 4. **The socket connects to exactly the address that was vetted.** Resolving
 *    here and handing the bare name to `fetch()` means the connect resolves it
 *    a second time, and a hostile authoritative server answers the two queries
 *    differently (DNS rebinding: public for the check, `127.0.0.1` for the
 *    connect). So this does not use the global `fetch` at all: it issues the
 *    request with `node:http`/`node:https` and a `lookup` that hands back the
 *    vetted list and never asks DNS again. The name still goes out as the
 *    `Host` header and the TLS SNI/certificate name, so virtual hosting and
 *    certificate validation are unchanged. (undici's `Agent` would do the same
 *    job, but the `undici` package is not a dependency and Node's bundled copy
 *    exposes no constructor for one.)
 *
 * It also bounds time in a way no caller can opt out of: a socket that goes
 * `idleTimeoutMs` without a byte in either direction is destroyed. A caller may
 * shorten that, never disable it — see `MAX_IDLE_TIMEOUT_MS`.
 */

const MAX_REDIRECTS = 5;

/** Socket inactivity bound applied to every request. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** A caller asking for longer than this gets this. */
const MAX_IDLE_TIMEOUT_MS = 5 * 60_000;

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

export type HostResolver = (host: string) => Promise<{ address: string; family: number }[]>;

const systemResolver: HostResolver = (host) => dns.lookup(host, { all: true, verbatim: true });
let resolveHost: HostResolver = systemResolver;

/**
 * Test seam: replace the resolver. There is exactly one resolution per hop and
 * the connect reuses its answer, so a stub that answers differently on each
 * call is how the rebinding test proves nothing asks twice. `null` restores
 * the system resolver.
 */
export function setHostResolverForTests(resolver: HostResolver | null): HostResolver {
  const previous = resolveHost;
  resolveHost = resolver ?? systemResolver;
  return previous;
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function isBlockedIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments + TEST-NET-1
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return isBlockedIpv4Octets(p[0], p[1], p[2]);
}

/** Two 16-bit groups holding an embedded IPv4 address, judged as IPv4. */
function isBlockedEmbeddedV4(hi: number, lo: number): boolean {
  return isBlockedIpv4Octets(hi >> 8, hi & 0xff, lo >> 8);
}

/**
 * Parses any textual IPv6 form — compressed, expanded, with a trailing dotted
 * quad, with a zone id — into its eight 16-bit groups. `null` if it is not one.
 */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // A trailing dotted quad is the last two groups; rewrite it as them.
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const v4 = s.slice(lastColon + 1);
    if (!net.isIPv4(v4)) return null;
    const o = v4.split(".").map(Number);
    const hex = (n: number) => n.toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex((o[0] << 8) | o[1])}:${hex((o[2] << 8) | o[3])}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !rest) return null;
  const explicit = head.length + rest.length;
  if (halves.length === 1) return explicit === 8 ? head : null;
  if (explicit > 7) return null;
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest];
}

function isBlockedIpv6(ip: string): boolean {
  const w = parseIpv6(ip);
  if (!w) return true;
  const zeroUpTo = (n: number) => w.slice(0, n).every((g) => g === 0);

  // ::/128 unspecified, ::1/128 loopback.
  if (zeroUpTo(7) && (w[7] === 0 || w[7] === 1)) return true;
  // ::ffff:0:0/96 IPv4-mapped — the kernel delivers these as IPv4 connects.
  if (zeroUpTo(5) && w[5] === 0xffff) return isBlockedEmbeddedV4(w[6], w[7]);
  // ::/96 IPv4-compatible (deprecated, still routable on some stacks).
  if (zeroUpTo(6)) return isBlockedEmbeddedV4(w[6], w[7]);
  // ::ffff:0:0:0/96 IPv4-translated (SIIT).
  if (zeroUpTo(4) && w[4] === 0xffff && w[5] === 0) return isBlockedEmbeddedV4(w[6], w[7]);
  // 64:ff9b::/96 NAT64 well-known prefix: the gateway connects to the v4 inside.
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return isBlockedEmbeddedV4(w[6], w[7]);
  }
  // 64:ff9b:1::/48 local-use NAT64 — by definition someone's own network.
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true;
  // 2002::/16 6to4: the relay reaches the v4 address in groups 1-2.
  if (w[0] === 0x2002) return isBlockedEmbeddedV4(w[1], w[2]);
  // 2001::/32 Teredo and 2001:db8::/32 documentation: never a feed host.
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;
  // Everything else must be global unicast (2000::/3). That excludes, among
  // others, fe80::/10 link-local, fec0::/10 site-local, fc00::/7 unique-local
  // and ff00::/8 multicast — without needing a prefix list that can miss one.
  return (w[0] & 0xe000) !== 0x2000;
}

export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v = net.isIP(bare.split("%")[0]);
  if (v === 4) return isBlockedIpv4(bare);
  if (v === 6) return isBlockedIpv6(bare);
  return true;
}

interface VettedTarget {
  url: URL;
  /**
   * The addresses the connect may use. `null` for an IP literal (the socket
   * never does a lookup for one) or when the guard is off.
   */
  addresses: { address: string; family: number }[] | null;
}

async function vetUrl(raw: string): Promise<VettedTarget> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https URLs are allowed (got ${u.protocol})`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!allowPrivate && isBlockedAddress(host)) {
      throw new BlockedUrlError(`Refusing to fetch a non-public address: ${host}`);
    }
    return { url: u, addresses: null };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await resolveHost(host);
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addrs.length === 0) throw new BlockedUrlError(`Could not resolve ${host}`);
  if (!allowPrivate && addrs.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedUrlError(`Refusing to fetch a non-public address: ${host}`);
  }
  return { url: u, addresses: addrs };
}

/** Throws {@link BlockedUrlError} unless this URL is a public http(s) target. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  return (await vetUrl(raw)).url;
}

export interface SafeFetchInit {
  method?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Socket inactivity bound; clamped to `MAX_IDLE_TIMEOUT_MS`, never disabled. */
  idleTimeoutMs?: number;
}

/** A `lookup` that answers with the vetted list and never consults DNS. */
function pinnedLookup(addresses: { address: string; family: number }[]): net.LookupFunction {
  return (_hostname, options, callback) => {
    const wanted = options?.family === 4 || options?.family === 6 ? options.family : 0;
    const matching = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    const list = matching.length > 0 ? matching : addresses;
    if (options?.all) {
      (callback as (e: Error | null, a: { address: string; family: number }[]) => void)(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  };
}

function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null; // identity, or something we do not decode — passed through as-is
  }
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

interface HopResult {
  status: number;
  location: string | null;
  response: Response | null;
}

function requestOnce(
  target: VettedTarget,
  init: SafeFetchInit,
  finalUrl: string
): Promise<HopResult> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  headers["accept"] ??= "*/*";
  headers["accept-encoding"] ??= "gzip, deflate, br";

  const idleMs = Math.min(
    Math.max(1, init.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS),
    MAX_IDLE_TIMEOUT_MS
  );
  const signal = init.signal;
  const mod = target.url.protocol === "https:" ? https : http;

  return new Promise<HopResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let incoming: http.IncomingMessage | null = null;
    let settled = false;
    const fail = (err: Error) => {
      req.destroy(err);
      incoming?.destroy(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const onAbort = () => fail(abortReason(signal!));

    const req = mod.request(target.url, {
      method,
      headers,
      // A fresh socket per request. A pooled one would have been connected
      // for an earlier hop, and "which address is this socket on" must be
      // answerable from this call alone.
      agent: false,
      ...(target.addresses ? { lookup: pinnedLookup(target.addresses) } : {}),
    });
    // Inactivity on the socket, before *and* after the headers: a server that
    // accepts and then says nothing, or stops mid-body, is let go.
    req.setTimeout(idleMs, () => {
      fail(new Error(`No data from ${target.url.host} for ${Math.round(idleMs / 1000)}s`));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on("response", (res) => {
      incoming = res;
      const status = res.statusCode ?? 0;
      if (status >= 300 && status <= 399 && res.headers.location) {
        settled = true;
        res.resume();
        resolve({ status, location: res.headers.location, response: null });
        return;
      }
      if (status < 200 || status > 599) {
        fail(new Error(`Unexpected HTTP status ${status} from ${target.url.host}`));
        return;
      }
      const responseHeaders = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      }
      let body: ReadableStream<Uint8Array> | null = null;
      if (method === "HEAD" || NULL_BODY_STATUSES.has(status)) {
        res.resume();
      } else {
        const decoder = decoderFor(res.headers["content-encoding"]);
        const decoded: Readable = decoder ? pipeline(res, decoder, () => {}) : res;
        body = Readable.toWeb(decoded) as unknown as ReadableStream<Uint8Array>;
      }
      const response = new Response(body, {
        status,
        statusText: res.statusMessage ?? "",
        headers: responseHeaders,
      });
      // A constructed Response has an empty `url`; callers resolve relative
      // links against the final hop, as they did with `fetch()`.
      Object.defineProperty(response, "url", { value: finalUrl });
      settled = true;
      resolve({ status, location: null, response });
    });
    req.end();
  });
}

function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error(typeof r === "string" ? r : "The operation was aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Fetches a client-supplied URL, validating the target and every redirect hop
 * and connecting each hop only to the address its own check approved.
 *
 * Returns a standard `Response`. The body is already decoded
 * (`Content-Encoding: gzip/deflate/br`), so a byte cap applied to it counts
 * *decoded* bytes — which is the number that matters for a compression bomb.
 */
export async function safeFetch(raw: string, init: SafeFetchInit = {}): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await vetUrl(current);
    const result = await requestOnce(target, init, current);
    if (result.response) return result.response;
    current = new URL(result.location!, current).toString();
  }
  throw new BlockedUrlError(`Too many redirects starting at ${raw}`);
}
