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
}

// ---------------------------------------------------------------------------
// In-memory cache — avoids repeated disk reads for every getter call (F15)
// ---------------------------------------------------------------------------

let prefsCache: Prefs | null = null;

function getPrefsPath(): string {
  return path.join(app.getPath("userData"), PREFS_FILENAME);
}

function readPrefs(): Prefs {
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
