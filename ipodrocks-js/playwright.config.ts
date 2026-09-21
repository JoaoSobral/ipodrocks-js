import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defineConfig } from "@playwright/test";

/**
 * Two projects, because the app now has two front doors.
 *
 * **electron** drives the built desktop app, launched per test by
 * `electron-launcher.ts` — which is why it has no `webServer` block.
 *
 * **web** boots the headless daemon once and drives a plain Chromium page
 * against it. It gets its own data directory, wiped at config load, so a run
 * always starts from an unclaimed server: the first-run owner claim is part of
 * what the auth spec exercises.
 */

export const WEB_PORT = 8781;
export const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
export const WEB_DATA_DIR = path.join(os.tmpdir(), "ipodrocks-e2e-web");

// A stale database from a previous run would arrive with an owner already
// claimed, and the claim test would fail for a reason that has nothing to do
// with the code.
//
// **Only in the main process.** Playwright re-imports this config inside every
// worker, so an unguarded wipe here deletes the data directory *out from under
// the running daemon* — which showed up as "unable to open database file" in
// the harness rather than as anything resembling its cause. `TEST_WORKER_INDEX`
// is set only in workers.
if (process.env.TEST_WORKER_INDEX === undefined) {
  fs.rmSync(WEB_DATA_DIR, { recursive: true, force: true });
}
fs.mkdirSync(WEB_DATA_DIR, { recursive: true });

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.test\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "electron",
      testIgnore: /web-.*\.test\.ts/,
    },
    {
      name: "web",
      testMatch: /web-.*\.test\.ts/,
      use: {
        baseURL: WEB_ORIGIN,
      },
    },
  ],
  webServer: {
    command: "node dist/main/server/daemon.js",
    url: `${WEB_ORIGIN}/api/auth/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      IPODROCKS_DATA_DIR: WEB_DATA_DIR,
      IPODROCKS_SERVER_HOST: "127.0.0.1",
      IPODROCKS_SERVER_PORT: String(WEB_PORT),
      // Fixed, so a restart mid-run does not invalidate the cookie the tests
      // are holding.
      IPODROCKS_SESSION_SECRET: "e2e-session-secret-not-for-production",
      IPODROCKS_DISABLE_UPDATE_CHECK: "1",
    },
  },
});
