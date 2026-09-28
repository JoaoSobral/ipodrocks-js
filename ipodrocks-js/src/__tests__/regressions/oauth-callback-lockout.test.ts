/**
 * @vitest-environment node
 *
 * Regression — the OAuth callback's failure bucket was global per provider.
 *
 * `GET /api/auth/<provider>/callback` reserved an attempt against
 * `ip:<address>` *and* `acct:oauth:<provider>` — one constant string shared by
 * every user of that provider, given the per-account ceiling of ten. Ten bare
 * GETs from one unauthenticated client then answered every Google login, from
 * every address, with a 429, and because the refusal ran before passport no
 * successful login could reach `clearFailures()` to release it.
 *
 * The load-bearing assertion is the control: a callback from a *different*
 * address still reaches passport after the first address has burned through
 * its attempts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import express from "express";
import session from "express-session";
import lusca from "lusca";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let db: typeof import("../../server/db");
let server: http.Server;
let base: string;
let csrfToken: string;
let passportReached = 0;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-oauth-lockout-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();

  const { passport } = await import("../../server/auth/passport-setup");
  const { createAuthRouter } = await import("../../server/auth/routes");
  const rl = await import("../../server/auth/rate-limit");
  expect(rl.MAX_ATTEMPTS_PER_ACCOUNT).toBe(10);

  // A provider that always fails, standing in for a bogus code/state or a
  // user cancelling at the consent screen.
  passportReached = 0;
  passport.use("google", {
    authenticate(this: { fail: () => void }) {
      passportReached++;
      this.fail();
    },
  } as unknown as Parameters<typeof passport.use>[1]);

  const app = express();
  app.set("trust proxy", true); // lets the test choose the caller's address
  app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  app.use(lusca.csrf());
  app.get("/__test/csrf-token", (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });
  app.use(
    "/api/auth",
    createAuthRouter({
      config: {} as Parameters<typeof createAuthRouter>[0]["config"],
      enabledProviders: ["google"],
    })
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  const csrfRes = await fetch(`${base}/__test/csrf-token`);
  const csrfBody = (await csrfRes.json()) as { csrfToken: string };
  csrfToken = csrfBody.csrfToken;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function callback(from: string): Promise<number> {
  const res = await fetch(`${base}/api/auth/google/callback`, {
    headers: { "X-Forwarded-For": from, "x-csrf-token": csrfToken },
    redirect: "manual",
  });
  return res.status;
}

describe("OAuth callback failures are charged to the caller, not the provider", () => {
  it("ten bogus callbacks from one address do not lock out another", async () => {
    for (let i = 0; i < 12; i++) {
      // Each is processed by passport and bounced to the login page.
      expect(await callback("198.51.100.7")).toBe(302);
    }
    const before = passportReached;
    expect(await callback("203.0.113.20")).toBe(302);
    expect(passportReached).toBe(before + 1);
  });

  it("control: one address is still limited by its own bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push(await callback("198.51.100.8"));
    expect(statuses.slice(0, 60).every((s) => s === 302)).toBe(true);
    expect(statuses[60]).toBe(429);
    // And that lockout is the address's alone.
    expect(await callback("203.0.113.21")).toBe(302);
  });
});
