import { useCallback, useEffect, useState } from "react";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { Input } from "../common/Input";
import { Switch } from "../common/Switch";
import {
  getWebServerStatus,
  setWebServerConfig,
  startWebServer,
  stopWebServer,
  type WebServerStatus,
} from "../../ipc/api";

/**
 * Settings → Web Server.
 *
 * It applies and starts on its own buttons rather than through the modal's
 * Save. Starting a listener is an action with an immediate, visible result —
 * a URL, or a port-in-use error — and folding it into a Save that also writes
 * five unrelated preference groups would leave the user unsure which half
 * failed.
 */
export function WebServerCard({ open }: { open: boolean }) {
  const [status, setStatus] = useState<WebServerStatus | null>(null);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("8780");
  const [publicUrl, setPublicUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const s = await getWebServerStatus();
    setStatus(s);
    setHost(s.prefs.host ?? s.host ?? "127.0.0.1");
    setPort(String(s.prefs.port ?? s.port ?? 8780));
    setPublicUrl(s.prefs.publicUrl ?? "");
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  async function apply() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const parsedPort = Number.parseInt(port, 10);
      if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        setError("Port must be between 1 and 65535.");
        return;
      }
      await setWebServerConfig({
        host: host.trim(),
        port: parsedPort,
        publicUrl: publicUrl.trim(),
      });
      setSaved(true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const s = next ? await startWebServer() : await stopWebServer();
      setStatus(s);
      if (next && !s.running) {
        setError(s.lastError ?? "The server did not start.");
      }
    } finally {
      setBusy(false);
    }
  }

  const running = status?.running ?? false;

  return (
    <Card
      title="Web Server"
      subtitle="Serve iPodRocks in a browser, so the library can live on one machine and the iPod on another."
    >
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              Run the web server
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {running && status?.url ? (
                <>
                  Listening at{" "}
                  <span className="font-mono text-foreground">{status.url}</span>.
                </>
              ) : (
                "Off. The desktop app is unaffected either way — both talk to the same library."
              )}
            </p>
          </div>
          <Switch
            checked={running}
            onChange={(v) => void toggle(v)}
            disabled={busy}
            className="shrink-0"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Bind address"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            tooltip="127.0.0.1 keeps the server on this machine only, which is what you want behind a Cloudflare Tunnel. Use 0.0.0.0 to reach it from the LAN."
          />
          <Input
            label="Port"
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
          />
        </div>

        <Input
          label="Public URL"
          value={publicUrl}
          placeholder="https://ipod.example.com"
          onChange={(e) => setPublicUrl(e.target.value)}
          tooltip="The address people reach this server on. OAuth callback URLs are built from it, and it is the origin the WebSocket accepts."
        />

        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void apply()}>
            {busy ? "Applying…" : "Apply"}
          </Button>
          {saved && (
            <span className="text-xs text-muted-foreground">
              Saved — restart the server for it to take effect.
            </span>
          )}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>

        {status?.claimToken && (
          <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-1">
            <p className="text-xs font-medium text-foreground">
              Nobody owns this server yet
            </p>
            <p className="text-xs text-muted-foreground">
              Open it in a browser and sign in with this one-time claim token.
              The first account to present it becomes the owner; every later
              login is checked against the allowlist.
            </p>
            <code className="block text-xs font-mono break-all text-foreground">
              {status.claimToken}
            </code>
          </div>
        )}

        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {status && status.providers.length > 0
              ? `Sign-in providers configured: ${status.providers.join(", ")}.`
              : "No sign-in provider is configured."}{" "}
            Google, GitHub and Facebook credentials are read from environment
            variables and need a public HTTPS hostname, which a LAN install does
            not have — a local password account works everywhere.
          </p>
          {status?.lastError && (
            <p className="text-xs text-destructive">{status.lastError}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
