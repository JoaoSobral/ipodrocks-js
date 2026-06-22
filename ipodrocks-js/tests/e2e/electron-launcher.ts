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

export async function launchApp(extraEnv?: Record<string, string>): Promise<LaunchedApp> {
  if (!fs.existsSync(APP_ENTRY)) {
    throw new Error(
      `Built app not found at ${APP_ENTRY}. Run "npm run build" before "npx playwright test".`
    );
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-"));
  const app = await electron.launch({
    args: [APP_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Avoid auto-update checks while running tests
      IPODROCKS_DISABLE_UPDATE_CHECK: "1",
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
