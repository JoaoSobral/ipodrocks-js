import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  NoNativeDialogError,
  type HostAdapter,
  type HostDialogs,
  type HostPaths,
  type HostSecrets,
  type HostShell,
} from "./types";

/**
 * The headless host: plain Node, no Electron. Used by the web-server daemon
 * (`src/server/`) and by anything running under `ELECTRON_RUN_AS_NODE` where
 * Electron's `app` is undefined.
 *
 * This file must never import `electron`.
 */

/** Electron's `productName`, so a daemon on the same machine as the desktop
 *  app finds the same database instead of quietly starting an empty one. */
const APP_DIR_NAME = "iPodRocks";

function defaultUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_DIR_NAME);
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        APP_DIR_NAME
      );
    default:
      // Electron uses XDG_CONFIG_HOME (not XDG_DATA_HOME) on Linux; match it.
      return path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        APP_DIR_NAME
      );
  }
}

function readPackageVersion(): string {
  // dist/main/main/host/ → ../../../../package.json. Walk up rather than
  // hardcode the depth, so this survives a change in output layout.
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.version && parsed.name === "ipodrocks") return parsed.version;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

class NodePaths implements HostPaths {
  private cachedVersion: string | null = null;
  private ensured: string | null = null;

  /**
   * Electron's `app.getPath("userData")` *creates* the directory, and every
   * caller — `database.ts` opening SQLite, `prefs.ts` writing its JSON —
   * has always relied on that. The Node host returned a path without making
   * it, so a daemon pointed at a fresh `IPODROCKS_DATA_DIR` died on
   * `registerIpcHandlers()` with "Cannot open database because the directory
   * does not exist", a long way from the line that chose the path.
   */
  userData(): string {
    const override = process.env.IPODROCKS_DATA_DIR?.trim();
    const dir = override ? path.resolve(override) : defaultUserDataDir();
    if (this.ensured !== dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        this.ensured = dir;
      } catch {
        // Report the path anyway; the caller's own error is more specific
        // than anything that could be thrown from here.
      }
    }
    return dir;
  }

  temp(): string {
    return os.tmpdir();
  }

  music(): string {
    return path.join(os.homedir(), "Music");
  }

  isPackaged(): boolean {
    return false;
  }

  version(): string {
    if (this.cachedVersion === null) this.cachedVersion = readPackageVersion();
    return this.cachedVersion;
  }
}

/**
 * AES-256-GCM standing in for Electron's keychain-backed `safeStorage`.
 *
 * The key comes from `IPODROCKS_SECRET_KEY` (64 hex characters) when set —
 * the container-native way to supply it — otherwise from a `0600` key file
 * generated beside the prefs. A blob written here is deliberately tagged so
 * `decryptString` can tell "this is not mine" (an Electron safeStorage blob,
 * which it cannot read) from "this is mine and it is corrupt".
 */
class NodeSecrets implements HostSecrets {
  /** Identifies our own ciphertext. "IRS1" = iPodRocks secret, version 1. */
  private static readonly MAGIC = Buffer.from("IRS1", "ascii");
  private static readonly IV_BYTES = 12;
  private static readonly TAG_BYTES = 16;

  private cachedKey: Buffer | null = null;

  constructor(private readonly userDataDir: () => string) {}

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    const fromEnv = process.env.IPODROCKS_SECRET_KEY?.trim();
    if (fromEnv) {
      if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
        throw new Error(
          "IPODROCKS_SECRET_KEY must be 64 hex characters (32 bytes)"
        );
      }
      this.cachedKey = Buffer.from(fromEnv, "hex");
      return this.cachedKey;
    }

    const keyPath = path.join(this.userDataDir(), "secret.key");
    try {
      const existing = fs.readFileSync(keyPath, "utf-8").trim();
      if (/^[0-9a-fA-F]{64}$/.test(existing)) {
        this.cachedKey = Buffer.from(existing, "hex");
        return this.cachedKey;
      }
    } catch {
      // fall through and generate
    }

    const generated = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, generated.toString("hex"), { mode: 0o600 });
    try {
      // writeFileSync only applies mode when it creates the file.
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Windows and some mounts do not support this; not fatal.
    }
    this.cachedKey = generated;
    return generated;
  }

  isEncryptionAvailable(): boolean {
    try {
      this.key();
      return true;
    } catch {
      return false;
    }
  }

  encryptString(plainText: string): Buffer {
    const iv = crypto.randomBytes(NodeSecrets.IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key(), iv);
    const body = Buffer.concat([
      cipher.update(plainText, "utf-8"),
      cipher.final(),
    ]);
    return Buffer.concat([NodeSecrets.MAGIC, iv, cipher.getAuthTag(), body]);
  }

  decryptString(encrypted: Buffer): string {
    const { MAGIC, IV_BYTES, TAG_BYTES } = NodeSecrets;
    if (
      encrypted.length < MAGIC.length + IV_BYTES + TAG_BYTES ||
      !encrypted.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      // Almost certainly an Electron safeStorage blob. Say so plainly: this is
      // the one failure a daemon operator is likely to hit, and the remedy
      // (re-enter the key, or pass it by environment variable) is not guessable.
      throw new Error(
        "Encrypted value was not written by this host — a key encrypted by the " +
          "desktop app cannot be read by the headless server. Re-enter it, or " +
          "supply it via an environment variable."
      );
    }
    const iv = encrypted.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = encrypted.subarray(
      MAGIC.length + IV_BYTES,
      MAGIC.length + IV_BYTES + TAG_BYTES
    );
    const body = encrypted.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf-8"
    );
  }
}

class NodeShell implements HostShell {
  async openExternal(_url: string): Promise<{ opened: boolean }> {
    // There is no browser here — the client's browser opens it instead.
    return { opened: false };
  }
}

class NodeDialogs implements HostDialogs {
  readonly available = false;

  async pickFolder(): Promise<string | null> {
    throw new NoNativeDialogError("choosing a folder");
  }

  async saveFile(): Promise<string | null> {
    throw new NoNativeDialogError("saving a file");
  }
}

export function createNodeHost(): HostAdapter {
  const paths = new NodePaths();
  return {
    kind: "node",
    platform: process.platform,
    paths,
    secrets: new NodeSecrets(() => paths.userData()),
    shell: new NodeShell(),
    dialogs: new NodeDialogs(),
  };
}
