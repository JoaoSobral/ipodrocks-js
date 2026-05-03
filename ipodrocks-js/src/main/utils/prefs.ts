import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
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

interface Prefs {
  mpcRemindDisabled?: boolean;
  openRouterConfig?: OpenRouterConfig;
  /** Encrypted API key (base64). Present only when safeStorage was used. */
  _encApiKey?: string;
  harmonic?: HarmonicPrefs;
  /** Unix ms timestamp — auto update check is suppressed until this time. */
  updateSnoozeUntil?: number;
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
}

// ---------------------------------------------------------------------------
// In-memory cache — avoids repeated disk reads for every getter call (F15)
// ---------------------------------------------------------------------------

let prefsCache: Prefs | null = null;

function getPrefsPath(): string {
  return path.join(app.getPath("userData"), PREFS_FILENAME);
}

export function readPrefs(): Prefs {
  if (prefsCache !== null) return prefsCache;
  try {
    const p = getPrefsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as Prefs;

      // Decrypt API key if it was stored encrypted (F1)
      if (parsed._encApiKey && safeStorage.isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encApiKey, "base64");
          const decrypted = safeStorage.decryptString(buf);
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
      if (parsed._encPodcastIndexApiKey && safeStorage.isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encPodcastIndexApiKey, "base64");
          const decrypted = safeStorage.decryptString(buf);
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
      if (parsed._encPodcastIndexSecret && safeStorage.isEncryptionAvailable()) {
        try {
          const buf = Buffer.from(parsed._encPodcastIndexSecret, "base64");
          const decrypted = safeStorage.decryptString(buf);
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
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const encrypted = safeStorage.encryptString(toWrite.openRouterConfig.apiKey);
          toWrite._encApiKey = encrypted.toString("base64");
          toWrite.openRouterConfig = { ...toWrite.openRouterConfig, apiKey: "" };
        } catch {
          console.warn("[prefs] safeStorage encryption failed, storing key in plaintext");
        }
      } else {
        console.warn("[prefs] safeStorage unavailable, API key stored in plaintext");
      }
    }

    // Encrypt Podcast Index API key
    if (toWrite.podcastIndexConfig?.apiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const encrypted = safeStorage.encryptString(toWrite.podcastIndexConfig.apiKey);
          toWrite._encPodcastIndexApiKey = encrypted.toString("base64");
          toWrite.podcastIndexConfig = { ...toWrite.podcastIndexConfig, apiKey: "" };
        } catch {
          console.warn("[prefs] safeStorage encryption failed for podcast api key");
        }
      }
    }

    // Encrypt Podcast Index API secret
    if (toWrite.podcastIndexConfig?.apiSecret) {
      if (safeStorage.isEncryptionAvailable()) {
        try {
          const encrypted = safeStorage.encryptString(toWrite.podcastIndexConfig.apiSecret);
          toWrite._encPodcastIndexSecret = encrypted.toString("base64");
          toWrite.podcastIndexConfig = { ...toWrite.podcastIndexConfig, apiSecret: "" };
        } catch {
          console.warn("[prefs] safeStorage encryption failed for podcast secret");
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

export function getAutoPodcastSettings(): { enabled: boolean; refreshIntervalMinutes: number } {
  const s = readPrefs().autoPodcasts;
  return {
    enabled: s?.enabled ?? false,
    refreshIntervalMinutes: s?.refreshIntervalMinutes ?? 15,
  };
}

export function setAutoPodcastSettings(settings: {
  enabled?: boolean;
  refreshIntervalMinutes?: number;
  downloadDir?: string;
}): void {
  const prefs = readPrefs();
  prefs.autoPodcasts = { ...prefs.autoPodcasts, ...settings };
  writePrefs(prefs);
}

export function getPodcastDownloadDir(): string | null {
  return readPrefs().autoPodcasts?.downloadDir ?? null;
}
