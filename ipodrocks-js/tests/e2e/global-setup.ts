/**
 * Runs once, in the runner process, before any worker starts.
 *
 * Electron 43 no longer downloads its binary on `npm install`: the first
 * `require("electron")` does it (`getElectronPath()` → `install.js`). Playwright's
 * `_electron.launch()` makes that call, so with parallel workers on a fresh
 * checkout — every CI run — each worker started its own download into the same
 * `node_modules/electron/dist`, and one exec'd the binary while the other was
 * still writing it: `electron.launch: spawn ETXTBSY` on whichever spec happened
 * to be first. Resolving it here makes the download happen exactly once, before
 * anything can race it; on a machine that already has the binary it is a no-op.
 */
import * as fs from "fs";

export default function globalSetup(): void {
  const electronPath = require("electron") as unknown as string;
  if (!fs.existsSync(electronPath)) {
    throw new Error(`Electron binary missing at ${electronPath} after install.`);
  }
}
