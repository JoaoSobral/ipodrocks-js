import { createNodeHost } from "./node-host";
import type { HostAdapter } from "./types";

export * from "./types";
export { createNodeHost } from "./node-host";

/**
 * The active host adapter.
 *
 * `src/main/index.ts` registers the Electron host explicitly at startup and
 * `src/server/` registers the Node one. Anything that runs without either —
 * a vitest suite, a one-off script — gets the auto-detected host below, which
 * keeps existing tests working unchanged.
 */
let active: HostAdapter | null = null;

/**
 * Detects the host without a static `import "electron"`.
 *
 * Plain Node and `ELECTRON_RUN_AS_NODE` both resolve the `electron` package to
 * a path *string*, so `app` is undefined and we fall through to the Node host.
 * In a real Electron main process, and under the vitest harness's electron
 * mock, the module is an object with a usable `app` and we take that branch —
 * requiring `./electron-host` lazily, so its static electron import is only
 * ever reached on a host that has one.
 */
function detectHost(): HostAdapter {
  // A test run must never fall through to the real user-data directory. It
  // did once: `require("electron")` below is CommonJS, so vitest's
  // `vi.mock("electron")` does not intercept it, the Electron branch was
  // skipped, and the suite wrote its fixtures straight into the user's own
  // ipodrock.db. Fail loudly instead — `src/__tests__/setup.ts` sets the
  // variable, and the IPC harness registers a host of its own.
  if (process.env.VITEST && !process.env.IPODROCKS_DATA_DIR) {
    throw new Error(
      "No host registered under test and IPODROCKS_DATA_DIR is unset. " +
        "Refusing to auto-detect, because the fallback would resolve to the " +
        "real user-data directory. Register a host, or set IPODROCKS_DATA_DIR."
    );
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron");
    if (
      electron &&
      typeof electron === "object" &&
      typeof electron.app?.getPath === "function"
    ) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createElectronHost } = require("./electron-host");
      return createElectronHost();
    }
  } catch {
    // No electron here — that is the normal case for the daemon.
  }
  return createNodeHost();
}

/** Registers the host. Call once, before anything touches a path or a secret. */
export function setHost(host: HostAdapter): void {
  active = host;
}

export function getHost(): HostAdapter {
  if (!active) active = detectHost();
  return active;
}

/** Drops the cached host so the next `getHost()` re-detects. Tests only. */
export function resetHost(): void {
  active = null;
}

// ---------------------------------------------------------------------------
// Convenience accessors — the shapes call sites actually want
// ---------------------------------------------------------------------------

export function getUserDataPath(): string {
  return getHost().paths.userData();
}

export function getTempPath(): string {
  return getHost().paths.temp();
}

export function getMusicPath(): string {
  return getHost().paths.music();
}

export function isPackaged(): boolean {
  return getHost().paths.isPackaged();
}

export function getAppVersion(): string {
  return getHost().paths.version();
}

export function getSecrets() {
  return getHost().secrets;
}

export function getHostShell() {
  return getHost().shell;
}

export function getHostDialogs() {
  return getHost().dialogs;
}

export function getHostPlatform(): NodeJS.Platform {
  return getHost().platform;
}
