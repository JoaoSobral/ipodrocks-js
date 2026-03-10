import { useState } from "react";
import { WelcomePanel } from "./components/panels/WelcomePanel";
import { DashboardPanel } from "./components/panels/DashboardPanel";
import { LibraryPanel } from "./components/panels/LibraryPanel";
import { DevicePanel } from "./components/panels/DevicePanel";
import { SyncPanel } from "./components/panels/SyncPanel";
import { PlaylistPanel } from "./components/panels/PlaylistPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { FloatChat } from "./components/assistant/FloatChat";
import { ThemeToggle } from "./components/common/ThemeToggle";
import { useThemeStore } from "./stores/theme-store";

type Panel = "welcome" | "dashboard" | "library" | "devices" | "sync" | "playlists";

interface NavItem {
  id: Panel;
  label: string;
  icon: string;
}

const navItems: NavItem[] = [
  { id: "welcome", label: "Welcome", icon: "◆" },
  { id: "dashboard", label: "Dashboard", icon: "◈" },
  { id: "library", label: "Library", icon: "♫" },
  { id: "devices", label: "Devices", icon: "⊞" },
  { id: "playlists", label: "Playlists", icon: "≡" },
  { id: "sync", label: "Sync", icon: "⟳" },
];

const panels: Record<Panel, () => JSX.Element> = {
  welcome: WelcomePanel,
  dashboard: DashboardPanel,
  library: LibraryPanel,
  devices: DevicePanel,
  sync: SyncPanel,
  playlists: PlaylistPanel,
};

const SHOW_THEME_TOGGLE: Panel[] = [
  "welcome",
  "dashboard",
  "library",
  "devices",
  "sync",
  "playlists",
];

export function App() {
  const [active, setActive] = useState<Panel>("welcome");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { theme } = useThemeStore();
  const current = navItems.find((n) => n.id === active)!;
  const showThemeToggle = SHOW_THEME_TOGGLE.includes(active);

  return (
    <div
      data-theme={theme}
      className={`flex h-screen text-[#e0e0e0] select-none overflow-hidden bg-[#0d1015] ${theme === "light" ? "theme-light" : ""}`}
    >
      {/* Sidebar */}
      <nav className="flex flex-col w-56 shrink-0 border-r border-white/10 bg-[#0a0d11]">
        {/* macOS traffic lights spacer */}
        <div className="h-8 shrink-0 [-webkit-app-region:drag]" />

        <div className="px-5 pb-4">
          <h1 className="text-lg font-bold tracking-tight text-white">
            iPodRocks
          </h1>
          <p className="text-[10px] text-[#4a4f58] mt-0.5">Electron Edition</p>
        </div>

        <ul className="flex flex-col gap-0.5 px-2 flex-1">
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setActive(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-default ${
                  active === item.id
                    ? "nav-active bg-[#4a9eff]/15 text-[#4a9eff]"
                    : "nav-inactive text-[#8a8f98] hover:bg-white/5 hover:text-[#c0c4cc]"
                }`}
              >
                <span className="text-base w-5 text-center">{item.icon}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-white/10 px-5 py-3 [.theme-light_&]:border-[#e2e8f0]">
          <p className="text-[10px] text-[#4a4f58] [.theme-light_&]:text-[#6b7280]">v1.0.0</p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-white/10 px-8 py-4 shrink-0 [-webkit-app-region:drag] flex items-center justify-between [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:bg-[#f8f8f8]">
          <h2 className="text-xl font-semibold text-white flex items-center gap-2 [.theme-light_&]:text-[#1a1a1a]">
            <span>{current.icon}</span>
            {current.label}
          </h2>
          <div className="[-webkit-app-region:no-drag] flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg text-[#5a5f68] hover:text-white hover:bg-white/5 transition-colors [.theme-light_&]:text-[#6b7280] [.theme-light_&]:hover:text-[#1a1a1a]"
              title="Settings"
            >
              ⚙
            </button>
            {showThemeToggle && <ThemeToggle />}
          </div>
        </header>
        <div className="flex-1 overflow-auto px-8 py-6">
          {(() => {
            const ActivePanel = panels[active];
            return <ActivePanel />;
          })()}
        </div>
      </main>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <FloatChat />
    </div>
  );
}
