import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Card } from "../common/Card";
import { Switch } from "../common/Switch";
import {
  getOpenRouterConfig,
  setOpenRouterConfig,
  testOpenRouterConnection,
  checkSavantKeyData,
  getHarmonicPrefs,
  setHarmonicPrefs,
  podcastGetSettings,
  podcastSetSettings,
  podcastBrowseDownloadDir,
  podcastRefreshAllForNewFolder,
  podcastSearch,
} from "../../ipc/api";
import type { OpenRouterConfig, SavantKeyData, PodcastSettings } from "../../ipc/api";

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("anthropic/claude-sonnet-4.6");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "error"
  >("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [keyData, setKeyData] = useState<SavantKeyData | null>(null);
  const [saving, setSaving] = useState(false);
  const [podcastSettings, setPodcastSettings] = useState<PodcastSettings>({
    hasApiKey: false,
    hasSecret: false,
    apiKey: "",
    apiSecret: "",
    autoEnabled: false,
    intervalMin: 15,
    downloadDir: "",
    downloadDirCustom: null,
  });
  const [podcastApiKey, setPodcastApiKey] = useState("");
  const [podcastApiSecret, setPodcastApiSecret] = useState("");
  const [podcastTestStatus, setPodcastTestStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [podcastTestError, setPodcastTestError] = useState<string | null>(null);
  const [podcastDownloadDir, setPodcastDownloadDir] = useState("");
  const [podcastDownloadDirDefault, setPodcastDownloadDirDefault] = useState("");
  const [podcastDownloadDirOriginal, setPodcastDownloadDirOriginal] = useState("");
  const [scanHarmonicData, setScanHarmonicData] = useState(true);
  const [backfillPercent, setBackfillPercent] = useState(100);
  const [analyzeWithEssentia, setAnalyzeWithEssentia] = useState(false);
  const [analyzePercent, setAnalyzePercent] = useState(10);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [config, data, harmonic, podcastCfg] = await Promise.all([
        getOpenRouterConfig(),
        checkSavantKeyData(),
        getHarmonicPrefs(),
        podcastGetSettings(),
      ]);
      if (!cancelled) {
        setApiKey(config?.apiKey ?? "");
        setModel(config?.model ?? "anthropic/claude-sonnet-4.6");
        setKeyData(data);
        setScanHarmonicData(harmonic.scanHarmonicData ?? true);
        setBackfillPercent(harmonic.backfillPercent ?? 100);
        setAnalyzeWithEssentia(harmonic.analyzeWithEssentia ?? false);
        setAnalyzePercent(harmonic.analyzePercent ?? 10);
        setPodcastSettings(podcastCfg);
        setPodcastApiKey(podcastCfg.apiKey);
        setPodcastApiSecret(podcastCfg.apiSecret);
        setPodcastDownloadDirDefault(podcastCfg.downloadDir);
        const loaded = podcastCfg.downloadDirCustom ?? podcastCfg.downloadDir;
        setPodcastDownloadDir(loaded);
        setPodcastDownloadDirOriginal(loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleTest() {
    setTestStatus("testing");
    setTestError(null);
    try {
      // If apiKey contains the mask char it is the server-returned placeholder;
      // pass null so the main process uses the stored key directly.
      const isNewKey = apiKey.trim() && !apiKey.includes("•");
      const configToTest = isNewKey
        ? {
            apiKey: apiKey.trim(),
            model: model.trim() || "anthropic/claude-sonnet-4.6",
          }
        : null;
      const result = await testOpenRouterConnection(configToTest);
      if (result.ok) {
        setTestStatus("ok");
      } else {
        setTestStatus("error");
        setTestError(result.error ?? "Connection failed");
      }
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const modelId = model.trim() || "anthropic/claude-sonnet-4.6";
      const config: OpenRouterConfig = {
        apiKey: apiKey.trim(),
        model: modelId,
      };
      await setOpenRouterConfig(apiKey.trim() ? config : null);
      await setHarmonicPrefs({
        scanHarmonicData,
        backfillPercent: Math.min(100, Math.max(1, backfillPercent)),
        analyzeWithEssentia,
        analyzePercent: Math.min(100, Math.max(1, analyzePercent)),
      });
      const customDir = podcastDownloadDir.trim();
      const folderChanged = customDir !== podcastDownloadDirOriginal;
      await podcastSetSettings({
        apiKey: podcastApiKey.trim() || undefined,
        apiSecret: podcastApiSecret.trim() || undefined,
        autoEnabled: podcastSettings.autoEnabled,
        intervalMin: podcastSettings.intervalMin,
        downloadDir: customDir !== podcastDownloadDirDefault ? customDir : null,
      });
      if (folderChanged) {
        podcastRefreshAllForNewFolder();
      }
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handlePodcastTest() {
    setPodcastTestStatus("testing");
    setPodcastTestError(null);
    try {
      const result = await podcastSearch("test");
      if ("error" in result && result.error === "NO_CREDS") {
        setPodcastTestStatus("error");
        setPodcastTestError("No credentials configured");
      } else {
        setPodcastTestStatus("ok");
      }
    } catch (err) {
      setPodcastTestStatus("error");
      setPodcastTestError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI Settings"
      wide
      closeOnBackdropClick
    >
      <div className="space-y-6">
        <Card
          title="OpenRouter API"
          subtitle="Connect to AI models via OpenRouter for Savant playlists."
        >
          <div className="space-y-4">
            <Input
              label="API Key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-v1-..."
            />
            <Input
              label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="anthropic/claude-sonnet-4.6"
            />
            <p className="text-xs text-muted-foreground">
              Get your API key at{" "}
              <a
                href="https://openrouter.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                openrouter.ai
              </a>
              . Model ID from{" "}
              <a
                href="https://openrouter.ai/models?fmt=cards&input_modalities=text&output_modalities=text"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                openrouter.ai/models
              </a>
              .
            </p>
            <div className="flex items-center gap-3 pt-1">
              <Button
                size="sm"
                variant="secondary"
                disabled={testStatus === "testing"}
                onClick={handleTest}
              >
                {testStatus === "testing" ? "Testing…" : "Test Connection"}
              </Button>
              {testStatus === "ok" && (
                <span className="text-xs text-success">Connected</span>
              )}
              {testStatus === "error" && testError && (
                <span className="text-xs text-destructive">{testError}</span>
              )}
            </div>
          </div>
        </Card>

        <Card
          title="Harmonic Analysis"
          subtitle="Configure key/BPM detection for harmonic mixing."
        >
          <div className="space-y-5">
            {keyData && (
              <p className="text-xs text-muted-foreground">
                {keyData.keyedCount} / {keyData.totalCount} tracks have key data (
                {keyData.coveragePct}%).
                {keyData.bpmOnlyCount > 0 && (
                  <> {keyData.bpmOnlyCount} have BPM only.</>
                )}
              </p>
            )}

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Extract harmonic data on scan
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Read key and BPM from file tags during library scan.
                </p>
              </div>
              <Switch
                checked={scanHarmonicData}
                onChange={setScanHarmonicData}
                className="shrink-0"
              />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Analyze with Essentia.js
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Detect key/BPM from audio waveform (slower, more accurate).
                </p>
              </div>
              <Switch
                checked={analyzeWithEssentia}
                onChange={setAnalyzeWithEssentia}
                className="shrink-0"
              />
            </div>

            {analyzeWithEssentia && (
              <Input
                label="Analyze % of library"
                tooltip="When scanning new tracks, limit Essentia key/BPM detection to this percentage to control CPU usage."
                type="number"
                min={1}
                max={100}
                value={String(analyzePercent)}
                onChange={(e) =>
                  setAnalyzePercent(parseInt(e.target.value, 10) || 10)
                }
              />
            )}

            <Input
              label="Backfill: process up to % of library"
              tooltip="Run key and BPM detection on tracks that are missing harmonic data, up to this percentage of your total library."
              type="number"
              min={1}
              max={100}
              value={String(backfillPercent)}
              onChange={(e) =>
                setBackfillPercent(parseInt(e.target.value, 10) || 100)
              }
            />
          </div>
        </Card>

        <Card
          title="Auto Podcasts"
          subtitle="Configure the Podcast Index API for podcast search and auto-download."
        >
          <div className="space-y-4">
            <Input
              label="API Key"
              type="password"
              value={podcastApiKey}
              onChange={(e) => setPodcastApiKey(e.target.value)}
              placeholder="Podcast Index API key"
            />
            <Input
              label="API Secret"
              type="password"
              value={podcastApiSecret}
              onChange={(e) => setPodcastApiSecret(e.target.value)}
              placeholder="Podcast Index API secret"
            />
            <p className="text-xs text-muted-foreground">
              Get your free API key at{" "}
              <a
                href="https://api.podcastindex.org/signup"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                api.podcastindex.org/signup
              </a>
              .
            </p>

            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={podcastTestStatus === "testing"}
                onClick={handlePodcastTest}
              >
                {podcastTestStatus === "testing" ? "Testing…" : "Test Connection"}
              </Button>
              {podcastTestStatus === "ok" && (
                <span className="text-xs text-success">Connected</span>
              )}
              {podcastTestStatus === "error" && podcastTestError && (
                <span className="text-xs text-destructive">{podcastTestError}</span>
              )}
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Enable auto refresh & sync
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically check for new episodes and sync to enabled devices.
                </p>
              </div>
              <Switch
                checked={podcastSettings.autoEnabled}
                onChange={(v) => setPodcastSettings((s) => ({ ...s, autoEnabled: v }))}
                className="shrink-0"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">
                Download folder
              </label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={podcastDownloadDir}
                  title={podcastDownloadDir}
                  className="flex-1 min-w-0 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground truncate outline-none cursor-default"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    const picked = await podcastBrowseDownloadDir();
                    if (picked) setPodcastDownloadDir(picked);
                  }}
                >
                  Browse…
                </Button>
                {podcastDownloadDir !== podcastDownloadDirDefault && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPodcastDownloadDir(podcastDownloadDirDefault)}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>

            {podcastSettings.autoEnabled && (
              <div>
                <label className="text-xs font-medium text-foreground">
                  Refresh interval
                </label>
                <select
                  value={String(podcastSettings.intervalMin)}
                  onChange={(e) =>
                    setPodcastSettings((s) => ({
                      ...s,
                      intervalMin: parseInt(e.target.value, 10),
                    }))
                  }
                  className="mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every hour</option>
                </select>
              </div>
            )}
          </div>
        </Card>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
