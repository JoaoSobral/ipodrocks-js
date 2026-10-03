/**
 * Playwright E2E — recovering a forgotten owner password on a headless server
 * with no shell, through the token `IPODROCKS_RESET_OWNER=1` prints at boot.
 *
 * The flag is read at startup, so this spec cannot use the shared `web`
 * daemon: it boots its own on another port against its own data directory,
 * claims it, restarts it with the flag, and reads the token **from the log**,
 * the way an operator would. The reset itself goes through the rendered login
 * screen; the refusals around it go through the route.
 *
 * What it pins: the token works once, a wrong one does nothing, a weak
 * password does not burn it, and a restart without the flag closes the route.
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { test, expect, request as playwrightRequest } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = 8782;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DAEMON = path.resolve(__dirname, "..", "..", "dist", "main", "server", "daemon.js");
const OWNER = "reset-owner";
const FORGOTTEN = "a-password-nobody-remembers";
const RECOVERED = "the-recovered-owner-password";

let dataDir: string;
let daemon: ChildProcess | null = null;
let log = "";

async function boot(extraEnv: Record<string, string> = {}): Promise<void> {
  log = "";
  daemon = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      IPODROCKS_DATA_DIR: dataDir,
      IPODROCKS_SERVER_HOST: "127.0.0.1",
      IPODROCKS_SERVER_PORT: String(PORT),
      IPODROCKS_SESSION_SECRET: "e2e-owner-reset-secret",
      IPODROCKS_DISABLE_UPDATE_CHECK: "1",
      IPODROCKS_RESET_OWNER: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  daemon.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/api/auth/status`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not start:\n${log}`);
}

async function shutdown(): Promise<void> {
  const proc = daemon;
  daemon = null;
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill("SIGTERM");
  await exited;
}

function claimToken(): string {
  const db = new Database(path.join(dataDir, "ipodrocks-server.db"), { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM server_settings WHERE key = 'owner_claim_token'")
      .get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

async function loginStatus(password: string): Promise<number> {
  const ctx = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const res = await ctx.post("/api/auth/local/login", {
    data: { username: OWNER, password },
  });
  await ctx.dispose();
  return res.status();
}

async function resetAvailable(): Promise<boolean> {
  const res = await fetch(`${ORIGIN}/api/auth/status`);
  return ((await res.json()) as { ownerResetAvailable: boolean }).ownerResetAvailable;
}

test.beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-owner-reset-"));
  await boot();
  const ctx = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const claimed = await ctx.post("/api/auth/local/claim", {
    data: { username: OWNER, password: FORGOTTEN, claimToken: claimToken() },
  });
  expect(claimed.ok()).toBe(true);
  await ctx.dispose();
  await shutdown();
});

test.afterAll(async () => {
  await shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the printed token resets the owner from the login screen, once", async ({ page }) => {
  await boot({ IPODROCKS_RESET_OWNER: "1" });
  const printed = /Owner password reset[\s\S]*?│\s+([A-Za-z0-9_-]{32})\s*│/.exec(log);
  expect(printed, `the token is in the log:\n${log}`).not.toBeNull();
  const token = printed![1];
  expect(await resetAvailable()).toBe(true);

  const api = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const wrong = await api.post("/api/auth/local/reset-owner", {
    data: { token: "x".repeat(32), newPassword: RECOVERED },
  });
  expect(wrong.status()).toBe(403);
  const weak = await api.post("/api/auth/local/reset-owner", {
    data: { token, newPassword: "short" },
  });
  expect(weak.status()).toBe(400);
  expect(await resetAvailable(), "a weak password does not burn the token").toBe(true);

  await page.goto(ORIGIN);
  await page.getByRole("button", { name: "Reset owner password" }).click();
  await page.locator("#reset-token").fill(token);
  await page.locator('input[type="password"]').fill(RECOVERED);
  const done = page.waitForResponse((r) => r.url().endsWith("/api/auth/local/reset-owner"));
  await page.getByRole("button", { name: "Reset password and sign in" }).click();
  expect((await done).status()).toBe(200);

  // Signed in as the owner by the reset itself.
  const status = (await (await page.request.get(`${ORIGIN}/api/auth/status`)).json()) as {
    authenticated: boolean;
    user: { isOwner: boolean } | null;
  };
  expect(status.authenticated).toBe(true);
  expect(status.user?.isOwner).toBe(true);

  expect(await loginStatus(FORGOTTEN)).toBe(401);
  expect(await loginStatus(RECOVERED)).toBe(200);

  const reuse = await api.post("/api/auth/local/reset-owner", {
    data: { token, newPassword: "a-third-owner-password" },
  });
  expect(reuse.status(), "the token is single-use").toBe(403);
  expect(await resetAvailable()).toBe(false);
  await api.dispose();
});

test("a restart without the flag closes the route and hides the link", async ({ page }) => {
  await shutdown();
  await boot({ IPODROCKS_RESET_OWNER: "1" });
  const printed = /Owner password reset[\s\S]*?│\s+([A-Za-z0-9_-]{32})\s*│/.exec(log);
  const token = printed![1];
  await shutdown();

  await boot();
  expect(await resetAvailable()).toBe(false);
  const api = await playwrightRequest.newContext({ baseURL: ORIGIN });
  const res = await api.post("/api/auth/local/reset-owner", {
    data: { token, newPassword: "a-fourth-owner-password" },
  });
  expect(res.status()).toBe(403);
  await api.dispose();

  await page.goto(ORIGIN);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset owner password" })).toHaveCount(0);
});
