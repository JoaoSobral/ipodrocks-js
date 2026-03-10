import { useEffect, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import {
  getOpenRouterConfig,
  setOpenRouterConfig,
  testOpenRouterConnection,
  checkSavantKeyData,
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const config = await getOpenRouterConfig();
      const data = await checkSavantKeyData();
      if (!cancelled) {
        setApiKey(config?.apiKey ?? "");
        setModel(config?.model ?? "anthropic/claude-sonnet-4.6");
        setKeyData(data);
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

        {keyData && (
          <section>
            <h4 className="text-sm font-semibold text-white mb-2">
              Harmonic Data
            </h4>
            <p className="text-xs text-[#5a5f68]">
              {keyData.keyedCount} / {keyData.totalCount} tracks have key/BPM
              data ({keyData.coveragePct}%). Re-scan your library to extract
              more.
            </p>
          </section>
        )}

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
