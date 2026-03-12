import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
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
  harmonic?: HarmonicPrefs;
}

function getPrefsPath(): string {
  return path.join(app.getPath("userData"), PREFS_FILENAME);
}

function readPrefs(): Prefs {
  try {
    const p = getPrefsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return JSON.parse(raw) as Prefs;
    }
  } catch {
    // ignore
  }
  return {};
}

function writePrefs(prefs: Prefs): void {
  try {
    const p = getPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(prefs, null, 2), "utf-8");
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
