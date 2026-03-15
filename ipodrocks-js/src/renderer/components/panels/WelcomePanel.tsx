import { Card } from "../common/Card";
import { useThemeStore } from "../../stores/theme-store";
import logoSrcTransp from "@assets/ipodRocks_transp.png?url";
import logoSrcBlack from "@assets/ipodRocks_black.png?url";

const APP_VERSION = "1.0.3.1";

const FEATURES: { icon: string; label: string; description: string }[] = [
  {
    icon: "📤",
    label: "Sync",
    description:
      "Rockbox, any mountable device. Full or custom sync by album, artist, genre, playlist.",
  },
  {
    icon: "📱",
    label: "Multiple devices",
    description:
      "Add and switch between devices, each with its own codec and folder layout.",
  },
  {
    icon: "📚",
    label: "Library & shadow libraries",
    description:
      "Music, podcasts, audiobooks. Pre-transcoded mirrors (e.g. FLAC→MPC) for fast sync.",
  },
  {
    icon: "📋",
    label: "Playlists",
    description:
      "Smart (rules), Genius (playback logs), Savant (AI from mood). Create by voice via Assistant.",
  },
  {
    icon: "💬",
    label: "Music Assistant",
    description:
      "Floating chat that knows your library. Ask questions, create playlists by talking.",
  },
  {
    icon: "🎹",
    label: "Harmonic mixing",
    description:
      "Camelot wheel, key and BPM detection. Savant uses harmonic data for smooth transitions.",
  },
  {
    icon: "🔄",
    label: "Conversion & codecs",
    description:
      "Per-device config: direct copy, MP3, AAC, Musepack, Opus. FFmpeg with metadata preserved.",
  },
];

export function WelcomePanel() {
  const { theme } = useThemeStore();
  const logoSrc = theme === "light" ? logoSrcTransp : logoSrcBlack;
  return (
    <div className="panel-content max-w-2xl mx-auto space-y-5">
      {/* Hero card: logo + about */}
      <Card className="overflow-hidden border-border bg-muted/30">
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
              Made by Pedro · v{APP_VERSION} — Electron Edition
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

      {/* Features — grid like genius playlist selection */}
      <Card title="Features" subtitle="What you can do with iPodRocks">
        <div className="grid grid-cols-2 gap-3">
          {FEATURES.map((f, i) => (
            <div
              key={i}
              className="text-left p-4 rounded-xl border border-border bg-muted/30"
            >
              <div className="text-2xl mb-2">{f.icon}</div>
              <h4 className="text-sm font-semibold text-foreground">
                {f.label}
              </h4>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* Getting started */}
      <Card title="Get started" subtitle="Use the sidebar to navigate">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Use <strong className="text-foreground">Dashboard</strong> for an
          overview, <strong className="text-foreground">Library</strong> to add
          folders and scan, <strong className="text-foreground">Devices</strong>{" "}
          to add and configure each Rockbox (or mountable) device,{" "}
          <strong className="text-foreground">Playlists</strong> to create
          smart, genius, or Savant playlists, and{" "}
          <strong className="text-foreground">Sync</strong> to copy music and
          podcasts to the device. Open <strong className="text-foreground">
            Settings
          </strong>{" "}
          (gear icon) to add your OpenRouter API key for Savant and Assistant
          features.
        </p>
      </Card>
    </div>
  );
}
