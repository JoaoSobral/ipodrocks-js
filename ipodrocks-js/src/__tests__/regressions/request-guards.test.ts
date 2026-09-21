/**
 * Regression — the two HTTP-surface guards added for the PR #140 security
 * review: cross-origin refusal on state-changing API requests, and a coarse
 * flood ceiling in front of the routes that do work.
 *
 * Both were raised by CodeQL (`js/missing-token-validation`,
 * `js/missing-rate-limiting`) against a server whose only CSRF protection was
 * the `SameSite=Lax` cookie and whose only limiter counted *failed logins*.
 * Neither finding was a hole on its own — Lax withholds the cookie from a
 * cross-site POST, and every flagged route sits behind `requireAuth` — but
 * "the cookie policy happens to save us" is not a guard you can point at, and
 * a per-failure counter says nothing about a client asking for legitimate
 * things as fast as it can.
 *
 * The origin matrix is tested here rather than end to end because most of its
 * interesting rows are header combinations no browser will produce on demand.
 */
import { describe, it, expect } from "vitest";
import * as http from "http";
import express from "express";
import { judgeRequestOrigin, requireSameOrigin } from "../../server/origin-guard";
import {
  identityAdminRateLimiter,
  IDENTITY_ADMIN_LIMIT,
  API_LIMIT,
  API_WINDOW_MS,
  AUTH_LIMIT,
} from "../../server/rate-limits";

const ALLOWED = ["http://127.0.0.1:8781", "https://ipod.example"];

function judge(opts: {
  method?: string;
  origin?: string;
  secFetchSite?: string;
}) {
  return judgeRequestOrigin({
    method: opts.method ?? "POST",
    origin: opts.origin,
    secFetchSite: opts.secFetchSite,
    allowedOrigins: ALLOWED,
  });
}

describe("judgeRequestOrigin", () => {
  it("admits the app's own origin", () => {
    expect(judge({ origin: "http://127.0.0.1:8781" })).toBe("same-origin");
    expect(judge({ origin: "https://ipod.example" })).toBe("same-origin");
  });

  it("refuses an origin this server does not serve", () => {
    expect(judge({ origin: "https://evil.example" })).toBe("cross-site");
    // The same host on another port is another origin, which is the whole
    // point: a second service on the LAN box is not us.
    expect(judge({ origin: "http://127.0.0.1:9999" })).toBe("cross-site");
  });

  it("refuses the literal `null` origin a sandboxed document sends", () => {
    expect(judge({ origin: "null" })).toBe("cross-site");
  });

  it("exempts safe methods, because the OAuth callback is one", () => {
    // `GET /api/auth/<provider>/callback` is a top-level navigation the
    // provider performs. It arrives cross-site by construction, and refusing
    // it would break every social login.
    expect(judge({ method: "GET", origin: "https://accounts.google.com" })).toBe(
      "safe-method"
    );
    expect(judge({ method: "HEAD", origin: "https://evil.example" })).toBe(
      "safe-method"
    );
  });

  it("admits a request with no Origin at all", () => {
    // CSRF needs a browser, and a browser always sends `Origin` on a POST.
    // Refusing this would lock out curl, a script and the e2e harness for no
    // security gain.
    expect(judge({})).toBe("no-origin");
  });

  it("believes Sec-Fetch-Site over anything the page could set", () => {
    expect(judge({ secFetchSite: "cross-site", origin: "http://127.0.0.1:8781" })).toBe(
      "cross-site"
    );
    // A sibling subdomain is not us — on a LAN install it is quite possibly
    // somebody else's box.
    expect(judge({ secFetchSite: "same-site", origin: "http://127.0.0.1:8781" })).toBe(
      "cross-site"
    );
    expect(judge({ secFetchSite: "same-origin" })).toBe("same-origin");
    // `none` is a user-initiated navigation: the address bar, not a page.
    expect(judge({ secFetchSite: "none" })).toBe("same-origin");
  });
});

/** Boots a throwaway express app on an ephemeral port. */
async function listen(app: express.Express): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe("requireSameOrigin as middleware", () => {
  it("answers 403 JSON rather than falling through", async () => {
    const app = express();
    app.use("/api", requireSameOrigin(ALLOWED));
    app.post("/api/thing", (_req, res) => {
      res.json({ reached: true });
    });
    const { url, close } = await listen(app);
    try {
      const refused = await fetch(`${url}/api/thing`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "Cross-origin request refused" });

      // The control: the guard is not a blanket refusal of POSTs.
      const allowed = await fetch(`${url}/api/thing`, {
        method: "POST",
        headers: { origin: "https://ipod.example" },
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ reached: true });
    } finally {
      await close();
    }
  });
});

describe("rate limiters", () => {
  it("the allowlist bucket answers 429 once its ceiling is reached", async () => {
    const app = express();
    app.use("/api/auth/identities", identityAdminRateLimiter());
    app.get("/api/auth/identities", (_req, res) => {
      res.json({ ok: true });
    });
    const { url, close } = await listen(app);
    try {
      let last = 0;
      // One past the ceiling. Nothing here shares a store with the daemon, so
      // burning the bucket costs nothing.
      for (let i = 0; i < IDENTITY_ADMIN_LIMIT + 1; i++) {
        last = (await fetch(`${url}/api/auth/identities`)).status;
      }
      expect(last).toBe(429);

      const body = await (await fetch(`${url}/api/auth/identities`)).json();
      expect(body).toEqual({ error: "Too many allowlist requests. Try again later." });
    } finally {
      await close();
    }
  }, 30_000);

  it("keeps the control plane's ceiling far above a person and far below a loop", () => {
    // Pinned as numbers because that is the whole judgement being made. A
    // panel load fires dozens of channels and a seek fires a Range request per
    // jump, so a per-minute ceiling in the low hundreds would break the app;
    // thirty-odd requests a second sustained is not somebody using it.
    expect(API_WINDOW_MS).toBe(60_000);
    expect(API_LIMIT).toBe(2000);
    // The auth surface is per-fifteen-minutes, and generous because a
    // household shares one address behind NAT. The tight per-account ceiling
    // that makes password guessing pointless is in `auth/rate-limit.ts`.
    expect(AUTH_LIMIT).toBe(600);
    expect(IDENTITY_ADMIN_LIMIT).toBe(120);
  });
});
