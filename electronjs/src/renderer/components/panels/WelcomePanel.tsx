import { Card } from "../common/Card";
import { useThemeStore } from "../../stores/theme-store";
import logoSrcTransp from "@assets/ipodRocks_transp.png?url";
import logoSrcBlack from "@assets/ipodRocks_black.png?url";

const APP_VERSION = "1.0.0";

const FEATURES: { title: string; desc: string }[] = [
  {
    title: "Sync to Rockbox",
    desc: "Copy your library to iPods and any device running Rockbox",
  },
  {
    title: "Any mountable device",
    desc: "Works with anything that mounts as a drive; you copy files to a folder",
  },
  {
    title: "Multiple devices",
    desc: "Add and switch between several devices, each with its own profile",
  },
  {
    title: "Genius playlists",
    desc: "Build playlists from device playback logs (Rediscovery, Forgotten Gems, etc.)",
  },
  {
    title: "Smart playlists",
    desc: "Rule-based playlists by genre, artist, album, with track limits",
  },
  {
    title: "Savant playlists",
    desc: "AI-powered playlists from mood and energy (requires OpenRouter API key)",
  },
  {
    title: "Mood Chat",
    desc: "Conversational playlist creation — describe your mood, get a tailored playlist",
  },
  {
    title: "Harmonic mixing",
    desc: "Camelot wheel, key-aware sequencing for smooth DJ-style transitions",
  },
  {
    title: "Assistant",
    desc: "Floating chat for library help and questions",
  },
  {
    title: "Dashboard",
    desc: "Library stats, device overview, and shadow library status at a glance",
  },
  {
    title: "Podcasts",
    desc: "Separate podcast folders and sync; full or custom sync per content type",
  },
  {
    title: "Full or custom sync",
    desc: "Sync everything or pick specific albums, artists, genres, playlists",
  },
  {
    title: "Conversion & codecs",
    desc: "Per-device codec configs, FFmpeg conversion with metadata preserved",
  },
];

const textPrimary = "text-white [.theme-light_&]:text-[#1a1a1a]";
const textMuted = "text-[#8a8f98] [.theme-light_&]:text-[#6b7280]";
const textMutedSm = "text-[#5a5f68] [.theme-light_&]:text-[#6b7280]";

export function WelcomePanel() {
  const { theme } = useThemeStore();
  const logoSrc = theme === "light" ? logoSrcTransp : logoSrcBlack;
  return (
    <div className="panel-content max-w-2xl mx-auto space-y-5">
      {/* Hero card: logo + about */}
      <Card className="overflow-hidden border-white/[0.08] !bg-[#171716] [.theme-light_&]:!bg-gradient-to-br [.theme-light_&]:from-[#f0f4f8] [.theme-light_&]:to-[#e2e8f0] [.theme-light_&]:border-[#e2e8f0]">
        <div className="flex flex-col sm:flex-row items-center gap-6 p-2 [.theme-light_&]:bg-transparent">
          <div className="shrink-0 rounded-lg p-1 bg-[#171716] [.theme-light_&]:bg-transparent">
            <img
              src={logoSrc}
              alt="iPodRocks"
              className="w-32 h-32 object-contain"
            />
          </div>
          <div className="flex-1 text-center sm:text-left">
            <h2 className={`text-2xl font-bold tracking-tight ${textPrimary}`}>
              iPodRocks
            </h2>
            <p className={`text-sm mt-2 leading-relaxed ${textMuted}`}>
              A sync tool between your managed music library and a device running
              Rockbox — or any device that mounts as a drive so you can copy
              files to a folder.
            </p>
            <p className={`text-xs mt-2 ${textMutedSm}`}>
              Made by Pedro · v{APP_VERSION} — Electron Edition
            </p>
          </div>
        </div>
      </Card>

      {/* Features */}
      <Card
        title="Features"
        subtitle="What you can do with iPodRocks"
        className="[.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0]"
      >
        <ul className="space-y-4">
          {FEATURES.map((f, i) => (
            <li key={i} className="flex items-start gap-3">
              <span
                className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 bg-[#4a9eff]/20 text-[#4a9eff] [.theme-light_&]:bg-[#16a34a]/20 [.theme-light_&]:text-[#16a34a]`}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <span
                  className={`font-semibold text-sm ${textPrimary}`}
                >
                  {f.title}
                </span>
                <p className={`text-sm mt-0.5 leading-relaxed ${textMuted}`}>
                  {f.desc}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* Getting started */}
      <Card
        title="Get started"
        subtitle="Use the sidebar to navigate"
        className="[.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0]"
      >
        <p className={`text-sm leading-relaxed ${textMuted}`}>
          Use <strong className={textPrimary}>Dashboard</strong> for an overview,{" "}
          <strong className={textPrimary}>Library</strong> to add folders and scan,{" "}
          <strong className={textPrimary}>Devices</strong> to add and configure each{" "}
          Rockbox (or mountable) device, <strong className={textPrimary}>Playlists</strong> to
          create smart, genius, or Savant playlists, and <strong className={textPrimary}>Sync</strong> to{" "}
          copy music and podcasts to the device. Open <strong className={textPrimary}>Settings</strong> (gear{" "}
          icon) to add your OpenRouter API key for Savant and Assistant features.
        </p>
      </Card>
    </div>
  );
}
