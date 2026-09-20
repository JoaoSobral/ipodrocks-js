/**
 * Regression — the HTTP surface's small, load-bearing pieces.
 *
 * Each of these is a place where getting it subtly wrong produces a bug that
 * looks like something else entirely:
 *
 * - **One channel allowlist.** It used to live inside `preload.ts`. A second
 *   copy in the server would drift the first time a domain was added, and the
 *   symptom would be "the feature works in the desktop app and 403s over the
 *   web" — a long way from the list that caused it.
 * - **Range parsing.** A media element seeks by asking for byte ranges; the
 *   suffix form (`bytes=-N`) and the open-ended form (`bytes=N-`) are both
 *   used in practice and are easy to get backwards.
 * - **Media tokens.** The signature is checked before the payload is parsed,
 *   and a token minted for one session must not be honoured for another.
 * - **The CSP meta strip.** The policy baked into `index.html` names the
 *   `media:` scheme and has no `connect-src`; left in place it intersects with
 *   the header and blocks the app's own WebSocket.
 * - **The WebSocket origin check.** An absent `Origin` is not same-origin.
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_CHANNEL_PREFIXES,
  isAllowedChannel,
  isPushChannel,
} from "../../shared/ipc-channels";
import { parseRange } from "../../server/media-route";
import {
  issueMediaToken,
  resetMediaTokenKey,
  verifyMediaToken,
} from "../../server/media-token";
import { buildCsp, injectBaseHref, stripCspMeta } from "../../server/http";
import { originAllowed } from "../../server/events";
import { normalizeOrigin } from "../../server/config";

describe("channel allowlist", () => {
  it("is the same list the preload enforces", () => {
    // Not a copy: the preload imports this module. The assertion is that the
    // domains actually registered are covered, which is what would break if
    // someone added `src/main/ipc/foo.ts` with a new prefix.
    for (const prefix of ["library:", "device:", "sync:", "player:", "server:"]) {
      expect(ALLOWED_CHANNEL_PREFIXES).toContain(prefix);
    }
  });

  it("refuses a channel with no known prefix", () => {
    expect(isAllowedChannel("library:getTracks")).toBe(true);
    expect(isAllowedChannel("secret:doThing")).toBe(false);
    expect(isAllowedChannel("")).toBe(false);
    // Not a prefix match against the middle of the name.
    expect(isAllowedChannel("evil-library:getTracks")).toBe(false);
  });

  it("keeps the subscribable set closed", () => {
    expect(isPushChannel("scan:progress")).toBe(true);
    // Allowed to invoke, but not something a client may subscribe to — a
    // client must not be able to name a channel and receive another user's
    // frames.
    expect(isPushChannel("library:getTracks")).toBe(false);
  });
});

describe("parseRange", () => {
  const size = 100;

  it("reads an explicit range", () => {
    expect(parseRange("bytes=0-9", size)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=10-19", size)).toEqual({ start: 10, end: 19 });
  });

  it("reads the open-ended form a seek sends", () => {
    expect(parseRange("bytes=50-", size)).toEqual({ start: 50, end: 99 });
  });

  it("reads the suffix form used to fetch a trailing tag", () => {
    expect(parseRange("bytes=-10", size)).toEqual({ start: 90, end: 99 });
    // A suffix longer than the file is the whole file, not an error.
    expect(parseRange("bytes=-500", size)).toEqual({ start: 0, end: 99 });
  });

  it("clamps an end past the last byte rather than refusing", () => {
    expect(parseRange("bytes=95-999", size)).toEqual({ start: 95, end: 99 });
  });

  it("reports an unsatisfiable range instead of serving something else", () => {
    expect(parseRange("bytes=100-", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=20-10", size)).toBe("unsatisfiable");
  });

  it("treats no header and a malformed one as no range at all", () => {
    expect(parseRange(undefined, size)).toBeNull();
    expect(parseRange("bytes=", size)).toBeNull();
    expect(parseRange("items=0-9", size)).toBeNull();
  });
});

describe("media tokens", () => {
  it("round-trips a path", () => {
    resetMediaTokenKey();
    const token = issueMediaToken("/music/song.mp3", null);
    expect(verifyMediaToken(token, "any-session")).toBe("/music/song.mp3");
  });

  it("refuses a tampered signature", () => {
    resetMediaTokenKey();
    const token = issueMediaToken("/music/song.mp3", null);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyMediaToken(flipped, null)).toBeNull();
  });

  it("refuses a forged payload, because the HMAC is checked first", () => {
    resetMediaTokenKey();
    const body = Buffer.from(
      JSON.stringify({ p: "/etc/passwd", e: 2 ** 40 }),
      "utf-8"
    ).toString("base64url");
    expect(verifyMediaToken(`${body}.fake-signature`, null)).toBeNull();
  });

  it("honours a session-bound token only for that session", () => {
    resetMediaTokenKey();
    const token = issueMediaToken("/tmp/ipodrocks-player/abc.ogg", "session-a");
    expect(verifyMediaToken(token, "session-a")).toBe(
      "/tmp/ipodrocks-player/abc.ogg"
    );
    // The player's temp directory is one directory for the whole server, so a
    // replayed URL must not read another user's in-progress transcode.
    expect(verifyMediaToken(token, "session-b")).toBeNull();
    expect(verifyMediaToken(token, null)).toBeNull();
  });

  it("refuses an expired token", () => {
    resetMediaTokenKey();
    const token = issueMediaToken("/music/song.mp3", null, -1);
    expect(verifyMediaToken(token, null)).toBeNull();
  });

  it("invalidates every outstanding token when the key rotates", () => {
    resetMediaTokenKey();
    const token = issueMediaToken("/music/song.mp3", null);
    resetMediaTokenKey();
    expect(verifyMediaToken(token, null)).toBeNull();
  });
});

describe("content security policy", () => {
  it("names connect-src, which the baked-in meta policy does not", () => {
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("frame-ancestors 'none'");
    // `media:` is an Electron scheme; a browser tab has never heard of it.
    expect(csp).not.toContain("media:");
  });

  it("strips the desktop meta policy from the served HTML", () => {
    const html =
      '<head>\n  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; media-src \'self\' media:;" />\n  <title>iPodRocks</title>\n</head>';
    const stripped = stripCspMeta(html);
    expect(stripped).not.toContain("Content-Security-Policy");
    expect(stripped).toContain("<title>iPodRocks</title>");
  });
});

describe("base href", () => {
  it("pins relative asset URLs to the root", () => {
    // Vite builds with `base: "./"` for the desktop build's `file://` load, so
    // every asset reference is relative. The SPA fallback serves this same
    // document for any unmatched path; without a base, `/anything` yields a
    // page whose scripts resolve to `/anything/assets/…` and a blank screen.
    const html = '<head>\n  <script src="./assets/index.js"></script>\n</head>';
    expect(injectBaseHref(html)).toContain('<base href="/">');
  });

  it("leaves a document that already declares one alone", () => {
    const html = '<head><base href="/app/"><title>x</title></head>';
    expect(injectBaseHref(html)).toBe(html);
  });
});

describe("websocket origin check", () => {
  const allowed = ["https://ipod.example.com", "http://127.0.0.1:8780"];

  it("accepts a configured origin and refuses anything else", () => {
    expect(originAllowed("https://ipod.example.com", allowed)).toBe(true);
    expect(originAllowed("https://evil.example.com", allowed)).toBe(false);
  });

  it("refuses a missing Origin rather than reading it as same-origin", () => {
    // Browsers always send one on a WebSocket handshake. Treating its absence
    // as trusted is the usual way CSWSH protection is quietly lost.
    expect(originAllowed(undefined, allowed)).toBe(false);
    expect(originAllowed("", allowed)).toBe(false);
  });

  it("compares origins, not URLs with paths", () => {
    expect(normalizeOrigin("https://ipod.example.com/app/")).toBe(
      "https://ipod.example.com"
    );
    expect(normalizeOrigin("not a url")).toBeNull();
  });
});
