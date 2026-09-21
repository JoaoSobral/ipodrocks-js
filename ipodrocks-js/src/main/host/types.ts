/**
 * The electron-free boundary.
 *
 * Everything under `src/main/` that used to reach for `electron` directly now
 * goes through a `HostAdapter`. Two implementations exist: `electron-host.ts`
 * (the desktop app) and `node-host.ts` (the headless web-server daemon, which
 * must run in a container with no Electron installed at all).
 *
 * The rule that keeps this honest: **no module in this folder except
 * `electron-host.ts` may import `electron`**, and nothing imports
 * `electron-host.ts` except `src/main/index.ts`. A static `import` of electron
 * anywhere else would make the daemon's bundle unloadable under plain Node,
 * where the `electron` package resolves to a path string at best and is absent
 * from `node_modules` at worst.
 */

/** Well-known directories. Named rather than a generic `getPath(key)` so the
 *  set a host must implement is closed and typed. */
export interface HostPaths {
  /** Where the SQLite database, prefs file and downloaded media live. */
  userData(): string;
  /** Scratch space; the player writes transcodes here. */
  temp(): string;
  /** The user's music folder — only a default for a folder picker. */
  music(): string;
  /** Running from a packaged bundle (so `process.resourcesPath` is meaningful). */
  isPackaged(): boolean;
  /** The application version, as shown in the UI and used by the update check. */
  version(): string;
}

/**
 * At-rest encryption for API keys in `ipodrocks-prefs.json`.
 *
 * Mirrors the three members of Electron's `safeStorage` that `utils/prefs.ts`
 * actually uses. Note the asymmetry this creates and that the daemon must
 * report clearly: a blob written by Electron's keychain-backed implementation
 * is **not** readable by the Node host, and vice versa.
 */
export interface HostSecrets {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Opening a URL in the user's browser. Meaningless server-side, where the
 *  browser is the client's, so the Node host reports it as unhandled and the
 *  web UI calls `window.open()` itself. */
export interface HostShell {
  openExternal(url: string): Promise<{ opened: boolean }>;
}

export interface OpenFolderOptions {
  title?: string;
  defaultPath?: string;
}

export interface SaveFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

/**
 * Native OS dialogs. The Node host cannot show one — there is no screen — and
 * throws `NO_NATIVE_DIALOG`, which the web server turns into a prompt for the
 * browser to answer with its own directory browser instead.
 */
export interface HostDialogs {
  readonly available: boolean;
  pickFolder(opts?: OpenFolderOptions): Promise<string | null>;
  saveFile(opts?: SaveFileOptions): Promise<string | null>;
}

export interface HostAdapter {
  readonly kind: "electron" | "node";
  /** `process.platform` for the *host*; the web transport overrides what the
   *  renderer sees, since the browser may be on a different OS entirely. */
  readonly platform: NodeJS.Platform;
  readonly paths: HostPaths;
  readonly secrets: HostSecrets;
  readonly shell: HostShell;
  readonly dialogs: HostDialogs;
}

/** Thrown by `node-host`'s dialogs. Callers catch it by `code`, not message. */
export class NoNativeDialogError extends Error {
  readonly code = "NO_NATIVE_DIALOG";
  constructor(what: string) {
    super(`No native dialog available for ${what} on this host`);
    this.name = "NoNativeDialogError";
  }
}
