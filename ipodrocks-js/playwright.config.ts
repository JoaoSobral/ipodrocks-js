import { defineConfig } from "@playwright/test";

/**
 * Playwright config — drives the built Electron app from `dist/`.
 *
 * Run with: `npm run build && npx playwright test` (the `test:e2e` script).
 * The build is intentionally not auto-triggered by `webServer` because the
 * Electron app is launched per-test by `electron-launcher.ts`, not via HTTP.
 */
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
});
