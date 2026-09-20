import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Isolate the whole suite from the real user-data directory.
 *
 * Without this a test that reaches `getUserDataPath()` without going through
 * the IPC harness resolves the *actual* application support folder and writes
 * into the user's own library database. That happened. `host/index.ts` also
 * refuses to auto-detect under VITEST unless this is set, so the two guards
 * cover each other.
 */
if (!process.env.IPODROCKS_DATA_DIR) {
  process.env.IPODROCKS_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "ipodrocks-vitest-")
  );
}

afterEach(() => {
  if (typeof document !== "undefined") {
    cleanup();
  }
});
