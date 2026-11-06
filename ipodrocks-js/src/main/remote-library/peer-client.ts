import type * as crypto from "crypto";
import { safeFetch, BlockedUrlError } from "../utils/safe-fetch";
import { readBodyCapped } from "../utils/capped-stream";
import {
  getServerKeyPair,
  HDR_NONCE,
  HDR_RESPONSE_SIGNATURE,
  keyFingerprint,
  parsePeerPublicKey,
  signRequest,
  verifyResponse,
} from "../../server/federation/signing";
import { peerAddressPolicy } from "./peer-policy";

/**
 * The recipient's HTTP client for one paired peer.
 *
 * Every rule here exists because the peer's host came in through an invite
 * link — remote input — and this server will connect to it on a timer:
 *
 * - **The origin is pinned.** `scheme://host[:port]`, parsed once at pairing
 *   (`parseInvite`), stored, and the only thing a request URL is ever built
 *   from. Nothing a peer *sends* — a catalogue row, a header, an error — is
 *   used to build a URL.
 * - **No redirects.** A peer has no reason to send one, so a 3xx is an error
 *   and never a hop. That is also what keeps the per-peer private-address
 *   exception and the Cloudflare Access headers from travelling anywhere else.
 * - **The address policy is per peer** (`peer-policy.ts`), never the global
 *   `IPODROCKS_ALLOW_PRIVATE_FETCH`, and `safeFetch` connects to exactly the
 *   address it checked.
 * - **Every response is countersigned** by the sharer's key from pairing
 *   (`signResponse`), over this request's own nonce. A host that answers
 *   without it — DNS re-pointed, a tunnel hijacked, a valid certificate for
 *   somebody else's box — is refused even though TLS succeeded.
 * - **Bodies are capped** before anything parses them.
 */

export const PAIR_BODY_MAX = 16 * 1024;
export const JSON_BODY_MAX = 16 * 1024 * 1024;
const REQUEST_IDLE_MS = 30_000;

export class PeerError extends Error {
  constructor(
    message: string,
    readonly kind: "revoked" | "rejected" | "unverified" | "busy" | "unreachable" | "invalid"
  ) {
    super(message);
    this.name = "PeerError";
  }
}

export interface ParsedInvite {
  origin: string;
  shareId: string;
  code: string;
}

/** Share ids are 12 random bytes and codes 24, both base64url. */
const INVITE_FRAGMENT = /^#share=([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/;

/**
 * Parses and canonicalizes an invite link. `lan` permits plain `http:`; the
 * origin is `URL.origin`, so the host is lowercased, IDNA-encoded and a
 * default port is elided — two spellings of one peer pin to one string.
 */
export function parseInvite(link: unknown, lan: boolean): ParsedInvite | { error: string } {
  if (typeof link !== "string" || link.length > 512) return { error: "That is not an invite link." };
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return { error: "That is not an invite link." };
  }
  if (u.protocol !== "https:" && !(lan && u.protocol === "http:")) {
    return {
      error:
        u.protocol === "http:"
          ? "This invite is not over HTTPS. Only a server on your own LAN or tailnet may use plain HTTP — tick that box if it is."
          : "That is not an invite link.",
    };
  }
  if (u.username || u.password) return { error: "That is not an invite link." };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search) {
    return { error: "That is not an invite link." };
  }
  const m = INVITE_FRAGMENT.exec(u.hash);
  if (!m) return { error: "That is not an invite link." };
  return { origin: u.origin, shareId: m[1], code: m[2] };
}

export interface CfAccessCredentials {
  clientId: string;
  clientSecret: string;
}

export interface PeerTarget {
  origin: string;
  shareId: string;
  sharerPublicKey: string;
  lan: boolean;
  cf?: CfAccessCredentials | null;
}

function baseInit(lan: boolean, signal?: AbortSignal) {
  return {
    addressPolicy: peerAddressPolicy(lan),
    redirect: "error" as const,
    idleTimeoutMs: REQUEST_IDLE_MS,
    signal,
  };
}

function cfHeaders(origin: string, url: URL, cf?: CfAccessCredentials | null): Record<string, string> {
  // By construction every URL here is built from `origin`; checking anyway
  // means a future caller that builds one some other way cannot leak these.
  if (!cf || url.origin !== origin) return {};
  return { "cf-access-client-id": cf.clientId, "cf-access-client-secret": cf.clientSecret };
}

function wrapFetchError(err: unknown, origin: string): PeerError {
  if (err instanceof PeerError) return err;
  if (err instanceof BlockedUrlError) {
    return new PeerError(`${err.message}. Remote libraries never follow redirects or reach private addresses unless the peer was added as LAN/tailnet.`, "unreachable");
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new PeerError(`Could not reach ${origin}: ${msg}`, "unreachable");
}

export class PeerClient {
  private readonly sharerKey: crypto.KeyObject;

  constructor(readonly target: PeerTarget) {
    const key = parsePeerPublicKey(target.sharerPublicKey);
    if (!key) throw new PeerError("The stored key for this peer is unreadable.", "invalid");
    this.sharerKey = key;
  }

  get fingerprint(): string {
    return keyFingerprint(this.target.sharerPublicKey);
  }

  /**
   * One signed request. Resolves only with a response the sharer
   * countersigned; every other outcome is a `PeerError`.
   */
  async request(
    pathWithQuery: string,
    opts: { method?: "GET" | "HEAD"; headers?: Record<string, string>; signal?: AbortSignal } = {}
  ): Promise<Response> {
    if (!pathWithQuery.startsWith("/api/federation/")) {
      throw new PeerError("Refusing a request outside the federation API.", "invalid");
    }
    const method = opts.method ?? "GET";
    const url = new URL(pathWithQuery, this.target.origin);
    if (url.origin !== this.target.origin) {
      throw new PeerError("Refusing a request to a host other than the paired one.", "invalid");
    }
    const signed = signRequest(method, pathWithQuery, this.target.shareId);
    let res: Response;
    try {
      res = await safeFetch(url.toString(), {
        ...baseInit(this.target.lan, opts.signal),
        method,
        headers: {
          ...(opts.headers ?? {}),
          ...cfHeaders(this.target.origin, url, this.target.cf),
          ...signed,
        },
      });
    } catch (err) {
      throw wrapFetchError(err, this.target.origin);
    }

    const countersigned = verifyResponse(
      this.sharerKey,
      this.target.shareId,
      signed[HDR_NONCE],
      res.headers.get(HDR_RESPONSE_SIGNATURE)
    );
    if (!countersigned) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) {
        throw new PeerError(
          "The sharing server no longer recognises this server (or something else is answering at its address).",
          "rejected"
        );
      }
      throw new PeerError(
        `${this.target.origin} answered without proving it is the server you paired with. Nothing from it was used.`,
        "unverified"
      );
    }
    if (res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      throw new PeerError("The owner of this library has stopped sharing it.", "revoked");
    }
    if (res.status === 429) {
      const body = await readBodyCapped(res.body, 4096, "truncate").catch(() => Buffer.alloc(0));
      let msg = "The sharing server is busy. Try again later.";
      try {
        const parsed = JSON.parse(body.toString("utf-8")) as { error?: unknown };
        if (typeof parsed.error === "string") msg = parsed.error.slice(0, 200);
      } catch {
        /* keep the default */
      }
      throw new PeerError(msg, "busy");
    }
    return res;
  }

  async getJson<T>(pathWithQuery: string, signal?: AbortSignal): Promise<T> {
    const res = await this.request(pathWithQuery, { signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PeerError(`The sharing server answered ${res.status}.`, "unreachable");
    }
    const body = await readBodyCapped(res.body, JSON_BODY_MAX);
    try {
      return JSON.parse(body.toString("utf-8")) as T;
    } catch {
      throw new PeerError("The sharing server sent something that is not JSON.", "invalid");
    }
  }
}

export interface PairResult {
  target: PeerTarget;
  label: string;
  allowDownload: boolean;
  fingerprint: string;
}

/**
 * Redeems an invite: sends our public key, pins the sharer's, then proves the
 * pinning with one signed `/info` round trip before anything is stored.
 */
export async function pairWithInvite(
  link: unknown,
  opts: { lan: boolean; peerName: string; cf?: CfAccessCredentials | null; signal?: AbortSignal }
): Promise<PairResult> {
  const invite = parseInvite(link, opts.lan);
  if ("error" in invite) throw new PeerError(invite.error, "invalid");
  const url = new URL("/api/federation/pair", invite.origin);
  let res: Response;
  try {
    res = await safeFetch(url.toString(), {
      ...baseInit(opts.lan, opts.signal),
      method: "POST",
      headers: { "content-type": "application/json", ...cfHeaders(invite.origin, url, opts.cf) },
      body: JSON.stringify({
        shareId: invite.shareId,
        code: invite.code,
        publicKey: getServerKeyPair().publicKey,
        peerName: opts.peerName,
      }),
    });
  } catch (err) {
    throw wrapFetchError(err, invite.origin);
  }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    throw new PeerError("Too many attempts on this invite. Try again later.", "busy");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new PeerError(
      "The invite was not accepted. It may have been used already, have expired, or been revoked — ask for a new one.",
      "rejected"
    );
  }
  let parsed: { label?: unknown; allowDownload?: unknown; sharerPublicKey?: unknown };
  try {
    parsed = JSON.parse((await readBodyCapped(res.body, PAIR_BODY_MAX)).toString("utf-8"));
  } catch {
    throw new PeerError("The sharing server sent an unreadable answer.", "invalid");
  }
  if (typeof parsed.sharerPublicKey !== "string" || !parsePeerPublicKey(parsed.sharerPublicKey)) {
    throw new PeerError("The sharing server did not hand over a usable key.", "invalid");
  }
  const target: PeerTarget = {
    origin: invite.origin,
    shareId: invite.shareId,
    sharerPublicKey: parsed.sharerPublicKey,
    lan: opts.lan,
    cf: opts.cf ?? null,
  };
  const client = new PeerClient(target);
  // Proves the key we just pinned is the one answering signed requests.
  await client.getJson("/api/federation/info", opts.signal);
  return {
    target,
    label: typeof parsed.label === "string" ? parsed.label : "Shared library",
    allowDownload: parsed.allowDownload !== false,
    fingerprint: client.fingerprint,
  };
}
