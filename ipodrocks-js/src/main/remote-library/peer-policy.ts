import * as net from "net";
import { isBlockedAddress, parseIpv6, type AddressPolicy } from "../utils/safe-fetch";

/**
 * Which addresses the remote-library client may connect to.
 *
 * The peer's host arrives through an invite link, so this is an SSRF surface
 * and is stricter than feed fetching in two ways:
 *
 * - **The private-range exception is per peer**, granted by the owner when the
 *   peer is added ("this server is on my LAN / tailnet"), and passed to
 *   `safeFetch` as an `addressPolicy` for that peer's requests only. The global
 *   `IPODROCKS_ALLOW_PRIVATE_FETCH` never applies here, and since the client
 *   refuses redirects the exception cannot be inherited by another host.
 * - **Some addresses are refused whatever the flag says.** Loopback,
 *   link-local, unspecified, multicast and reserved space are simply never a
 *   friend's server. Cloud metadata endpoints are named *by exact value*,
 *   because two of them sit inside ranges a LAN peer may legitimately use:
 *   AWS's IPv6 IMDS `fd00:ec2::254` is unique-local, and Alibaba's
 *   `100.100.100.200` is inside CGNAT (`100.64/10`), which is also where
 *   Tailscale puts its nodes. Tailscale's own `100.100.100.100` (MagicDNS) is
 *   in the same position.
 *
 * Every textual form an address can take — IPv4-mapped/compatible IPv6, a
 * zone id, brackets — goes through the same parser `safeFetch` uses, and a
 * host name is judged per resolved address by `safeFetch` itself, which then
 * connects to exactly the address it judged (no DNS rebinding window).
 */

/**
 * Test seam for the two-daemon e2e, which necessarily runs both servers on
 * loopback. Checked `=== "1"`, set nowhere in the app, and even then honoured
 * only for a peer added with the LAN flag.
 */
export function loopbackPeersAllowed(): boolean {
  return process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK === "1";
}

/** Exact IPv4 values refused even with the LAN flag on. */
const ALWAYS_REFUSED_V4 = new Set(["169.254.169.254", "100.100.100.200", "100.100.100.100"]);
/** `fd00:ec2::254` as eight groups. */
const AWS_IMDS_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

function v4Octets(ip: string): number[] | null {
  if (net.isIPv4(ip)) return ip.split(".").map(Number);
  return null;
}

/**
 * Normalizes to either an IPv4 dotted quad (including the IPv4 inside an
 * IPv4-mapped `::ffff:a.b.c.d`) or eight IPv6 groups. Anything else is null and
 * refused.
 */
function normalize(raw: string): { v4: number[] } | { v6: number[] } | null {
  const bare = raw.replace(/^\[|\]$/g, "").split("%")[0];
  const four = v4Octets(bare);
  if (four) return { v4: four };
  if (!net.isIPv6(bare)) return null;
  const w = parseIpv6(bare);
  if (!w) return null;
  if (w.slice(0, 5).every((g) => g === 0) && w[5] === 0xffff) {
    return { v4: [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff] };
  }
  return { v6: w };
}

function isLanV4([a, b]: number[]): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isLoopback(n: { v4: number[] } | { v6: number[] }): boolean {
  if ("v4" in n) return n.v4[0] === 127;
  return n.v6.slice(0, 7).every((g) => g === 0) && n.v6[7] === 1;
}

/**
 * `true` = refuse. `lan` is the owner's per-peer flag.
 */
export function peerAddressRefused(ip: string, lan: boolean): boolean {
  const n = normalize(ip);
  if (!n) return true;

  if ("v4" in n && ALWAYS_REFUSED_V4.has(n.v4.join("."))) return true;
  if ("v6" in n && n.v6.every((g, i) => g === AWS_IMDS_V6[i])) return true;

  // Public is public. `isBlockedAddress` already rejects every embedded-IPv4
  // form (6to4, NAT64, SIIT) whose inner address is not public.
  const literal = "v4" in n ? n.v4.join(".") : ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (!isBlockedAddress(literal)) return false;

  if (!lan) return true;
  if (isLoopback(n)) return !loopbackPeersAllowed();
  if ("v4" in n) return !isLanV4(n.v4);
  // Unique-local fc00::/7 only — never link-local, site-local or multicast.
  return (n.v6[0] & 0xfe00) !== 0xfc00;
}

export function peerAddressPolicy(lan: boolean): AddressPolicy {
  return (ip) => peerAddressRefused(ip, lan);
}
