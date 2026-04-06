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
} from "../../ipc/api";
import type { OpenRouterConfig, SavantKeyData } from "../../ipc/api";

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
  const [scanHarmonicData, setScanHarmonicData] = useState(true);
  const [backfillPercent, setBackfillPercent] = useState(100);
  const [analyzeWithEssentia, setAnalyzeWithEssentia] = useState(false);
  const [analyzePercent, setAnalyzePercent] = useState(10);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [config, data, harmonic] = await Promise.all([
        getOpenRouterConfig(),
        checkSavantKeyData(),
        getHarmonicPrefs(),
      ]);
      if (!cancelled) {
        setApiKey(config?.apiKey ?? "");
        setModel(config?.model ?? "anthropic/claude-sonnet-4.6");
        setKeyData(data);
        setScanHarmonicData(harmonic.scanHarmonicData ?? true);
        setBackfillPercent(harmonic.backfillPercent ?? 100);
        setAnalyzeWithEssentia(harmonic.analyzeWithEssentia ?? false);
        setAnalyzePercent(harmonic.analyzePercent ?? 10);
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
      onClose();
    } finally {
      setSaving(false);
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
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                openrouter.ai/keys
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
