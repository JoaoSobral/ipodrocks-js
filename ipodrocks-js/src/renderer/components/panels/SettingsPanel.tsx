import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
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
      const configToTest = apiKey.trim()
        ? { apiKey: apiKey.trim(), model: model.trim() || "anthropic/claude-sonnet-4.6" }
        : undefined;
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
        <section>
          <h4 className="text-sm font-semibold text-white mb-3">
            OpenRouter
          </h4>
          <p className="text-xs text-[#5a5f68] mb-4">
            Savant playlists use OpenRouter to access AI models. Get your API key
            at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#4a9eff] hover:underline"
            >
              openrouter.ai/keys
            </a>
          </p>
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
          <p className="text-[11px] text-[#5a5f68] mt-1">
            Model ID from{" "}
            <a
              href="https://openrouter.ai/models?fmt=cards&input_modalities=text&output_modalities=text"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#4a9eff] hover:underline"
            >
              openrouter.ai/models
            </a>
          </p>
          <div className="flex items-center gap-3 mt-3">
            <Button
              size="sm"
              variant="secondary"
              disabled={testStatus === "testing"}
              onClick={handleTest}
            >
              {testStatus === "testing"
                ? "Testing…"
                : "Test Connection"}
            </Button>
            {testStatus === "ok" && (
              <span className="text-xs text-[#22c55e]">✓ Connected</span>
            )}
            {testStatus === "error" && testError && (
              <span className="text-xs text-[#ef4444]">{testError}</span>
            )}
          </div>
        </section>

        <section>
          <h4 className="text-sm font-semibold text-white mb-3 [.theme-light_&]:text-[#1a1a1a]">
            Harmonic Data (Key / BPM)
          </h4>
          {keyData && (
            <p className="text-xs text-[#5a5f68] mb-4 [.theme-light_&]:text-[#6b7280]">
              {keyData.keyedCount} / {keyData.totalCount} tracks have key/BPM
              data ({keyData.coveragePct}%).
            </p>
          )}
          <label className="flex items-center gap-3 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={scanHarmonicData}
              onChange={(e) => setScanHarmonicData(e.target.checked)}
              className="accent-[#4a9eff] rounded"
            />
            <span className="text-sm text-[#e0e0e0] [.theme-light_&]:text-[#374151]">
              Extract harmonic data when scanning library
            </span>
          </label>
          <p className="text-[11px] text-[#5a5f68] mb-4 [.theme-light_&]:text-[#6b7280]">
            When enabled, key and BPM are read from file tags during scan. Most
            files need &quot;Backfill Key Data&quot; on the Savant tab.
          </p>
          <div className="flex items-center gap-3">
            <label className="text-sm text-[#e0e0e0] [.theme-light_&]:text-[#374151]">
              Backfill: process up to
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={backfillPercent}
              onChange={(e) =>
                setBackfillPercent(parseInt(e.target.value, 10) || 100)
              }
              className="w-16 rounded-lg bg-white/[0.04] border border-white/[0.08] px-2 py-1.5 text-sm text-[#e0e0e0] [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a]"
            />
            <span className="text-sm text-[#5a5f68] [.theme-light_&]:text-[#6b7280]">
              % of library
            </span>
          </div>
          <p className="text-[11px] text-[#5a5f68] mt-1 [.theme-light_&]:text-[#6b7280]">
            Each backfill run processes up to this percentage of your music
            tracks.
          </p>
          <label className="flex items-center gap-3 mb-3 cursor-pointer mt-4">
            <input
              type="checkbox"
              checked={analyzeWithEssentia}
              onChange={(e) => setAnalyzeWithEssentia(e.target.checked)}
              className="accent-[#4a9eff] rounded"
            />
            <span className="text-sm text-[#e0e0e0] [.theme-light_&]:text-[#374151]">
              Analyze audio with Essentia.js (key/BPM from waveform)
            </span>
          </label>
          <p className="text-[11px] text-[#5a5f68] mb-4 [.theme-light_&]:text-[#6b7280]">
            When enabled, Backfill uses Essentia.js to detect key and BPM from
            the audio itself (not tags). Disabled by default. Samples across
            genres for diversity.
          </p>
          {analyzeWithEssentia && (
            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm text-[#e0e0e0] [.theme-light_&]:text-[#374151]">
                Analyze:
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={analyzePercent}
                onChange={(e) =>
                  setAnalyzePercent(parseInt(e.target.value, 10) || 10)
                }
                className="w-16 rounded-lg bg-white/[0.04] border border-white/[0.08] px-2 py-1.5 text-sm text-[#e0e0e0] [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a]"
              />
              <span className="text-sm text-[#5a5f68] [.theme-light_&]:text-[#6b7280]">
                % of library (spread by genre)
              </span>
            </div>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-2">
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
