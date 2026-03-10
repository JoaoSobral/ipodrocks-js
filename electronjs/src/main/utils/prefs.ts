import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { OpenRouterConfig } from "../../shared/types";

const PREFS_FILENAME = "ipodrocks-prefs.json";

interface Prefs {
  mpcRemindDisabled?: boolean;
  openRouterConfig?: OpenRouterConfig;
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
