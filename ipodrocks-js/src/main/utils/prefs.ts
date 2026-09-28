import * as fs from "fs";
import * as path from "path";
import { getSecrets, getUserDataPath } from "../host";
import type { OpenRouterConfig } from "../../shared/types";

const PREFS_FILENAME = "ipodrocks-prefs.json";

export interface HarmonicPrefs {
  /** When true, extract key/BPM during library scan. Default true. */
  scanHarmonicData?: boolean;
  /** Percent of library to process when backfilling (1–100). Default 100. */
  backfillPercent?: number;
  /** When true, use Essentia.js to analyze audio for key/BPM (not just tags). Default false. */
  analyzeWithEssentia?: boolean;
  /** Percent of library to analyze with Essentia (1–100). Sampled by genre. Default 10. */
  analyzePercent?: number;
}

export interface RatingPrefs {
  /**
   * Issue #118 follow-up: when true, a library scan makes the file's own
   * rating tag authoritative — overwriting `tracks.rating` (including
   * clearing it when the file is untagged) instead of only seeding an unrated
   * track, and resolving any open device conflicts on the tracks it touches
   * in the library's favor. Off by default: normal scans only ever seed a
   * rating no one has given yet (see rating-tag-backfill.ts / the upsert in
   * library-scanner.ts).
   */
  tagRatingAlwaysWins?: boolean;
}

/**
 * Deployment shape for the web server (`src/server/`). Third-party OAuth client
 * credentials are deliberately *not* here — they come from the environment
 * only; see `src/server/config.ts` for why.
 */
export interface WebServerPrefs {
  /** Start the server alongside the desktop window. Off by default. */
  enabled?: boolean;
  /** Bind address. Loopback by default, so enabling the toggle does not put an
   *  install on the LAN before its owner has set a password. */
  host?: string;
  port?: number;
  /** The externally visible origin, e.g. `https://ipod.example.com`. */
  publicUrl?: string;
  /** Addresses whose `X-Forwarded-*` headers may be believed. */
  trustedProxies?: string[];
  /** Extra origins accepted on the WebSocket upgrade. */
  allowedOrigins?: string[];
  tls?: { certPath: string; keyPath: string } | null;
}

interface Prefs {
  mpcRemindDisabled?: boolean;
  openRouterConfig?: OpenRouterConfig;
  /** Encrypted API key (base64). Present only when secret storage was available. */
  _encApiKey?: string;
  harmonic?: HarmonicPrefs;
  ratings?: RatingPrefs;
  /** Unix ms timestamp — auto update check is suppressed until this time. */
  updateSnoozeUntil?: number;
  /** Unix ms timestamp of the last automatic update check, throttling it to one/day. */
  lastAutoUpdateCheckAt?: number;
  /** Unix ms timestamps of recent *manual* update checks, capping requests/hour. */
  updateCheckTimestamps?: number[];
  podcastIndexConfig?: { apiKey: string; apiSecret: string };
  /** Encrypted Podcast Index API key (base64). */
  _encPodcastIndexApiKey?: string;
  /** Encrypted Podcast Index API secret (base64). */
  _encPodcastIndexSecret?: string;
  autoPodcasts?: {
    enabled?: boolean;
    refreshIntervalMinutes?: number;
    downloadDir?: string;
  };
  webServer?: WebServerPrefs;
}

// ---------------------------------------------------------------------------
// In-memory cache — avoids repeated disk reads for every getter call (F15)
// ---------------------------------------------------------------------------

let prefsCache: Prefs | null = null;

function getPrefsPath(): string {
  return path.join(getUserDataPath(), PREFS_FILENAME);
}

export function readPrefs(): Prefs {
  if (prefsCache !== null) return prefsCache;
  try {
    const p = getPrefsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as Prefs;

      // Decrypt API key if it was stored encrypted (F1)
      if (parsed._encApiKey && getSecrets().isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encApiKey, "base64");
          const decrypted = getSecrets().decryptString(buf);
          if (parsed.openRouterConfig) {
            parsed.openRouterConfig.apiKey = decrypted;
          } else {
            parsed.openRouterConfig = { apiKey: decrypted, model: "" };
          }
          delete parsed._encApiKey;
        } catch {
          // Decryption failed — fall through, apiKey may be missing
        }
      }

      // Decrypt Podcast Index API key
      if (parsed._encPodcastIndexApiKey && getSecrets().isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encPodcastIndexApiKey, "base64");
          const decrypted = getSecrets().decryptString(buf);
          if (parsed.podcastIndexConfig) {
            parsed.podcastIndexConfig.apiKey = decrypted;
          } else {
            parsed.podcastIndexConfig = { apiKey: decrypted, apiSecret: "" };
          }
          delete parsed._encPodcastIndexApiKey;
        } catch {
          // Decryption failed — fall through
        }
      }

      // Decrypt Podcast Index API secret
      if (parsed._encPodcastIndexSecret && getSecrets().isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encPodcastIndexSecret, "base64");
          const decrypted = getSecrets().decryptString(buf);
          if (parsed.podcastIndexConfig) {
            parsed.podcastIndexConfig.apiSecret = decrypted;
          } else {
            parsed.podcastIndexConfig = { apiKey: "", apiSecret: decrypted };
          }
          delete parsed._encPodcastIndexSecret;
        } catch {
          // Decryption failed — fall through
        }
      }

      prefsCache = parsed;
      return parsed;
    }
  } catch {
    // ignore
  }
  prefsCache = {};
  return prefsCache;
}

function writePrefs(prefs: Prefs): void {
  try {
    const p = getPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });

    // Encrypt API key before writing to disk (F1)
    const toWrite: Prefs = { ...prefs };
    if (toWrite.openRouterConfig?.apiKey) {
      if (getSecrets().isEncryptionAvailable()) {
        try {
          const encrypted = getSecrets().encryptString(toWrite.openRouterConfig.apiKey);
          toWrite._encApiKey = encrypted.toString("base64");
          toWrite.openRouterConfig = { ...toWrite.openRouterConfig, apiKey: "" };
        } catch {
          console.warn("[prefs] secret storage encryption failed, storing key in plaintext");
        }
      } else {
        console.warn("[prefs] secret storage unavailable, API key stored in plaintext");
      }
    }

    // Encrypt Podcast Index API key
    if (toWrite.podcastIndexConfig?.apiKey) {
      if (getSecrets().isEncryptionAvailable()) {
        try {
          const encrypted = getSecrets().encryptString(toWrite.podcastIndexConfig.apiKey);
          toWrite._encPodcastIndexApiKey = encrypted.toString("base64");
          toWrite.podcastIndexConfig = { ...toWrite.podcastIndexConfig, apiKey: "" };
        } catch {
          console.warn("[prefs] secret storage encryption failed for podcast api key");
        }
      }
    }

    // Encrypt Podcast Index API secret
    if (toWrite.podcastIndexConfig?.apiSecret) {
      if (getSecrets().isEncryptionAvailable()) {
        try {
          const encrypted = getSecrets().encryptString(toWrite.podcastIndexConfig.apiSecret);
          toWrite._encPodcastIndexSecret = encrypted.toString("base64");
          toWrite.podcastIndexConfig = { ...toWrite.podcastIndexConfig, apiSecret: "" };
        } catch {
          console.warn("[prefs] secret storage encryption failed for podcast secret");
        }
      }
    }

    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), "utf-8");
    fs.renameSync(tmp, p);

    // Update cache with the unencrypted version (F15)
    prefsCache = prefs;
  } catch (err) {
    console.error("[prefs] write failed:", err);
  }
}

export function getMpcRemindDisabled(): boolean {
  return readPrefs().mpcRemindDisabled === true;
}

export function setMpcRemindDisabled(value: boolean): void {
  const prefs = readPrefs();
  prefs.mpcRemindDisabled = value;
  writePrefs(prefs);
}

export function getOpenRouterConfig(): OpenRouterConfig | null {
  const cfg = readPrefs().openRouterConfig;
  if (!cfg?.apiKey?.trim()) return null;
  return cfg;
}

export function setOpenRouterConfig(config: OpenRouterConfig | null): void {
  const prefs = readPrefs();
  prefs.openRouterConfig = config ?? undefined;
  writePrefs(prefs);
}

export function getUpdateSnoozeUntil(): number | null {
  return readPrefs().updateSnoozeUntil ?? null;
}

export function setUpdateSnoozeUntil(ts: number | null): void {
  const prefs = readPrefs();
  if (ts === null) {
    delete prefs.updateSnoozeUntil;
  } else {
    prefs.updateSnoozeUntil = ts;
  }
  writePrefs(prefs);
}

export function getLastAutoUpdateCheckAt(): number | null {
  return readPrefs().lastAutoUpdateCheckAt ?? null;
}

export function setLastAutoUpdateCheckAt(ts: number): void {
  const prefs = readPrefs();
  prefs.lastAutoUpdateCheckAt = ts;
  writePrefs(prefs);
}

export function getUpdateCheckTimestamps(): number[] {
  return readPrefs().updateCheckTimestamps ?? [];
}

export function setUpdateCheckTimestamps(timestamps: number[]): void {
  const prefs = readPrefs();
  prefs.updateCheckTimestamps = timestamps;
  writePrefs(prefs);
}

export function getHarmonicPrefs(): HarmonicPrefs {
  const h = readPrefs().harmonic;
  return {
    scanHarmonicData: h?.scanHarmonicData ?? true,
    backfillPercent: Math.min(100, Math.max(1, h?.backfillPercent ?? 100)),
    analyzeWithEssentia: h?.analyzeWithEssentia ?? false,
    analyzePercent: Math.min(100, Math.max(1, h?.analyzePercent ?? 10)),
  };
}

export function setHarmonicPrefs(prefs: HarmonicPrefs): void {
  const all = readPrefs();
  all.harmonic = { ...all.harmonic, ...prefs };
  writePrefs(all);
}

export function getRatingPrefs(): RatingPrefs {
  return { tagRatingAlwaysWins: readPrefs().ratings?.tagRatingAlwaysWins ?? false };
}

export function setRatingPrefs(prefs: RatingPrefs): void {
  const all = readPrefs();
  all.ratings = { ...all.ratings, ...prefs };
  writePrefs(all);
}

export function getPodcastIndexConfig(): { apiKey: string; apiSecret: string } | null {
  const cfg = readPrefs().podcastIndexConfig;
  if (!cfg?.apiKey?.trim() || !cfg?.apiSecret?.trim()) return null;
  return cfg;
}

export function setPodcastIndexConfig(
  config: { apiKey: string; apiSecret: string } | null
): void {
  const prefs = readPrefs();
  prefs.podcastIndexConfig = config ?? undefined;
  writePrefs(prefs);
}

/** Podcast refresh cadence bounds, in minutes. */
export const PODCAST_INTERVAL_MIN_MINUTES = 5;
export const PODCAST_INTERVAL_MAX_MINUTES = 1440;
export const PODCAST_INTERVAL_DEFAULT_MINUTES = 15;

/**
 * Is this a refresh interval the scheduler may be handed?
 *
 * It reaches `setInterval`, and Node turns a delay that is NaN, below 1 or
 * above 2^31-1 ms into **1 ms** — so `"abc"`, `{}` or `1e12` (all of which
 * `Math.max(5, x)` either passes through or turns into NaN) made the scheduler
 * refresh every feed a thousand times a second, and the value persisted in this
 * file across restarts. A finite integer inside the bounds is the only answer.
 */
export function isValidPodcastInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PODCAST_INTERVAL_MIN_MINUTES &&
    value <= PODCAST_INTERVAL_MAX_MINUTES
  );
}

/**
 * Read side of the same rule: a prefs file written by an older version (or by
 * hand) can hold anything, so a stored value is clamped when it is a finite
 * number and replaced by the default when it is not. Never throws — a bad file
 * must not stop the app launching.
 */
function readPodcastInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return PODCAST_INTERVAL_DEFAULT_MINUTES;
  }
  return Math.min(
    PODCAST_INTERVAL_MAX_MINUTES,
    Math.max(PODCAST_INTERVAL_MIN_MINUTES, Math.round(value))
  );
}

export function getAutoPodcastSettings(): { enabled: boolean; refreshIntervalMinutes: number } {
  const s = readPrefs().autoPodcasts;
  return {
    // `=== true`: a stored `"false"` string is truthy.
    enabled: s?.enabled === true,
    refreshIntervalMinutes: readPodcastInterval(s?.refreshIntervalMinutes),
  };
}

/**
 * Validates everything it is given and throws before writing anything, so a
 * rejected call leaves the stored settings exactly as they were. `downloadDir`
 * is expected to have been through `validateFolderPath()` already — that check
 * needs the filesystem and lives with the IPC layer — so only its type is
 * checked here.
 */
export function setAutoPodcastSettings(settings: {
  enabled?: boolean;
  refreshIntervalMinutes?: number;
  downloadDir?: string;
}): void {
  if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
    throw new Error("autoEnabled must be true or false");
  }
  if (
    settings.refreshIntervalMinutes !== undefined &&
    !isValidPodcastInterval(settings.refreshIntervalMinutes)
  ) {
    throw new Error(
      `Refresh interval must be a whole number of minutes between ` +
        `${PODCAST_INTERVAL_MIN_MINUTES} and ${PODCAST_INTERVAL_MAX_MINUTES}`
    );
  }
  if (settings.downloadDir !== undefined && typeof settings.downloadDir !== "string") {
    throw new Error("downloadDir must be a folder path");
  }
  const prefs = readPrefs();
  const next = { ...prefs.autoPodcasts };
  // Only keys the caller actually set: spreading `{ enabled: undefined }` over
  // the stored object used to erase a value nobody meant to touch. The one
  // exception is `downloadDir`, where an explicit `undefined` is how the
  // Settings card says "back to the default folder".
  if (settings.enabled !== undefined) next.enabled = settings.enabled;
  if (settings.refreshIntervalMinutes !== undefined) {
    next.refreshIntervalMinutes = settings.refreshIntervalMinutes;
  }
  if ("downloadDir" in settings) next.downloadDir = settings.downloadDir;
  prefs.autoPodcasts = next;
  writePrefs(prefs);
}

export function getPodcastDownloadDir(): string | null {
  const dir = readPrefs().autoPodcasts?.downloadDir;
  return typeof dir === "string" && dir.trim() !== "" ? dir : null;
}

export function getWebServerPrefs(): WebServerPrefs {
  return readPrefs().webServer ?? {};
}

export function setWebServerPrefs(prefs: WebServerPrefs): void {
  const all = readPrefs();
  all.webServer = { ...all.webServer, ...prefs };
  writePrefs(all);
}
