/**
 * Launches the built Electron app for Playwright smoke tests.
 *
 * Each test calls `launchApp()` to get a fresh `ElectronApplication` pointed
 * at a tmp userData dir, then closes it in afterEach. Build output must exist
 * at `dist/main/main/index.js` — run `npm run build` first.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

const APP_ENTRY = path.resolve(__dirname, "..", "..", "dist", "main", "main", "index.js");

export interface LaunchedApp {
  app: ElectronApplication;
  userDataDir: string;
  cleanup: () => Promise<void>;
}

export async function launchApp(
  extraEnv?: Record<string, string>,
  opts?: { seedPrefs?: Record<string, unknown> }
): Promise<LaunchedApp> {
  if (!fs.existsSync(APP_ENTRY)) {
    throw new Error(
      `Built app not found at ${APP_ENTRY}. Run "npm run build" before "npx playwright test".`
    );
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-"));
  if (opts?.seedPrefs) {
    // Pre-populate main-process prefs (see src/main/utils/prefs.ts) before
    // Electron starts, so a test can start from non-default state (e.g. an
    // already-exhausted update-check rate limit) without driving the UI
    // through it first.
    fs.writeFileSync(
      path.join(userDataDir, "ipodrocks-prefs.json"),
      JSON.stringify(opts.seedPrefs, null, 2),
      "utf-8"
    );
  }
  // Its own temp directory too. The app keeps machine-wide scratch there
  // (the preview player's transcodes, which every launch empties at startup),
  // so with tests running in parallel one app would clear another's files.
  const tempDir = path.join(userDataDir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const app = await launchWithRetry({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Avoid auto-update checks while running tests
      IPODROCKS_DISABLE_UPDATE_CHECK: "1",
      // Keep the window off screen and out of the Dock. Playwright drives the
      // renderer over CDP, so nothing here needs it visible — and a full run
      // launches the app once per file, which otherwise means a couple of
      // minutes of windows stealing focus. Set IPODROCKS_HEADLESS=0 to watch a
      // run happen, which is worth doing when a UI test fails only in CI.
      IPODROCKS_HEADLESS: process.env.IPODROCKS_HEADLESS ?? "1",
      // Several specs stand up stub HTTP servers on loopback in place of
      // LibriVox, Google Books and real podcast feeds. `safeFetch` refuses
      // non-public addresses by default — that is the SSRF guard — so the
      // harness has to opt in the way a user with a feed on their own LAN
      // would. The guard itself is covered by
      // regressions/security-audit-hardening.test.ts.
      IPODROCKS_ALLOW_PRIVATE_FETCH: "1",
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      ...extraEnv,
    },
  });
  return {
    app,
    userDataDir,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

/**
 * `spawn ETXTBSY` is a transient on Linux CI: with every worker launching the
 * same Electron binary at once, an exec can briefly race another process's
 * fork and be refused. Nothing in the suite writes that binary, so a short
 * retry is the whole fix. Any other launch failure is real and thrown as-is.
 */
async function launchWithRetry(options: LaunchOptions): Promise<ElectronApplication> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await electron.launch(options);
    } catch (err) {
      if (attempt >= 5 || !String((err as Error)?.message).includes("ETXTBSY")) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}
