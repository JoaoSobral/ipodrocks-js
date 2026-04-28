import { useState, useEffect } from "react";
import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { UpdateAvailableModal } from "../modals/UpdateAvailableModal";
import { useThemeStore } from "../../stores/theme-store";
import { checkForUpdates, type CheckForUpdatesResult } from "../../ipc/api";
import logoSrcTransp from "@assets/ipodRocks_transp.png?url";
import logoSrcBlack from "@assets/ipodRocks_black.png?url";

const FEATURES: { icon: string; label: string; description: string }[] = [
  { icon: "📤", label: "Sync", description: "Full or custom sync by album, artist, genre, or playlist." },
  { icon: "📱", label: "Multiple devices", description: "Each device has its own codec and folder layout." },
  { icon: "📚", label: "Library & shadows", description: "Music, podcasts, audiobooks; FLAC→MPC mirrors." },
  { icon: "📋", label: "Playlists", description: "Smart, Genius, Savant (AI), voice via Assistant." },
  { icon: "💬", label: "Rocksy", description: "Chat that knows your library; create playlists by voice." },
  { icon: "🎹", label: "Harmonic mixing", description: "Key/BPM detection and Camelot wheel." },
  { icon: "🔄", label: "Conversion & codecs", description: "MP3, AAC, Musepack, Opus via FFmpeg." },
  { icon: "⭐", label: "Star ratings", description: "5-star (half-star), synced from Rockbox with 3-way merge." },
];

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "error" }
  | { status: "available"; result: CheckForUpdatesResult };

export function WelcomePanel() {
  const { theme } = useThemeStore();
  const logoSrc = theme === "light" ? logoSrcTransp : logoSrcBlack;
  const [updateState, setUpdateState] = useState<UpdateState>({ status: "idle" });

  const runCheck = async (auto: boolean) => {
    setUpdateState({ status: "checking" });
    const result = await checkForUpdates({ auto });
    if (result.updateAvailable && result.htmlUrl) {
      setUpdateState({ status: "available", result });
    } else if (result.snoozed) {
      setUpdateState({ status: "idle" });
    } else if (result.error) {
      setUpdateState(auto ? { status: "idle" } : { status: "error" });
    } else {
      setUpdateState({ status: "upToDate" });
    }
  };

  useEffect(() => { runCheck(true); }, []);

  const handleCheckForUpdates = () => runCheck(false);

  const handleModalClose = () => setUpdateState({ status: "idle" });

  return (
    <div className="panel-content max-w-2xl mx-auto space-y-5">
      {updateState.status === "available" && (
        <UpdateAvailableModal
          open
          onClose={handleModalClose}
          current={updateState.result.current}
          latest={updateState.result.latest}
          htmlUrl={updateState.result.htmlUrl!}
        />
      )}
      {/* Hero card: logo + about */}
      <Card className="overflow-hidden border-border bg-muted/30 relative">
        <div className="absolute top-2 right-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleCheckForUpdates}
            disabled={updateState.status === "checking"}
            title="Check for updates"
            style={{ backgroundColor: "#1a73e8", color: "#fff" }}
          >
            {updateState.status === "checking" && (
              <svg
                className="animate-spin h-3.5 w-3.5"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            )}
            {updateState.status === "checking"
              ? "Checking…"
              : updateState.status === "upToDate"
              ? "✓ Up to date"
              : updateState.status === "error"
              ? "Could not check"
              : "Check for updates"}
          </Button>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-6 p-2">
          <div className="shrink-0 rounded-lg p-1 bg-muted/30">
            <img
              src={logoSrc}
              alt="iPodRocks"
              className="w-32 h-32 object-contain"
            />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              iPodRocks
            </h2>
            <p className="text-sm mt-2 leading-relaxed text-muted-foreground">
              A sync tool between your managed music library and a device running
              Rockbox — or any device that mounts as a drive so you can copy
              files to a folder.
            </p>
            <p className="text-xs mt-2 text-muted-foreground">
              Made by Pedro Gonçalves
            </p>
            <a
              href="https://joaosobral.github.io/ipodrocks-js/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs mt-2 inline-block text-primary hover:underline"
            >
              📖 Full documentation →
            </a>
          </div>
        </div>
      </Card>

      {/* Getting started */}
      <Card title="Get started" subtitle="Use the sidebar to navigate">
        <ul className="text-sm text-muted-foreground space-y-1.5 list-none">
          <li><strong className="text-foreground">Dashboard</strong> — overview of your library and devices</li>
          <li><strong className="text-foreground">Library</strong> — add folders and scan your music</li>
          <li><strong className="text-foreground">Playlists</strong> — create smart, Genius, or Savant playlists</li>
          <li><strong className="text-foreground">Devices</strong> — add and configure each Rockbox or mountable device</li>
          <li><strong className="text-foreground">Sync</strong> — copy music and podcasts to the device</li>
          <li><strong className="text-foreground">Settings</strong> (gear icon) — add your OpenRouter API key for Savant and Rocksy</li>
        </ul>
      </Card>

      {/* Features — compact 2-column list */}
      <Card title="Features" subtitle="What you can do with iPodRocks">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          {FEATURES.map((f, i) => (
            <div key={i} className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{f.icon}</span>
                <span className="text-xs font-semibold text-foreground">{f.label}</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{f.description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
