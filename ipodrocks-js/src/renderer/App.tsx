import { useState, useEffect } from "react";
import { getAppVersion } from "./ipc/api";
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
import { useUIStore } from "./stores/ui-store";

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
  const [appVersion, setAppVersion] = useState("");
  const { theme } = useThemeStore();
  const setOpenSettings = useUIStore((s) => s.setOpenSettings);

  useEffect(() => {
    setOpenSettings(() => setSettingsOpen(true));
    return () => setOpenSettings(null);
  }, [setOpenSettings]);

  useEffect(() => {
    getAppVersion().then(({ version }) => setAppVersion(version));
  }, []);
  const current = navItems.find((n) => n.id === active)!;
  const showThemeToggle = SHOW_THEME_TOGGLE.includes(active);

  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [theme]);

  return (
    <div className="flex h-screen text-foreground select-none overflow-hidden bg-background">
      {/* Sidebar */}
      <nav className="flex flex-col w-56 shrink-0 border-r border-sidebar-border bg-sidebar">
        {/* macOS traffic lights spacer */}
        <div className="h-8 shrink-0 [-webkit-app-region:drag]" />

        <div className="px-5 pb-4">
          <h1 className="text-lg font-bold tracking-tight text-sidebar-foreground">
            iPodRocks
          </h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">Electron Edition</p>
        </div>

        <ul className="flex flex-col gap-0.5 px-2 flex-1">
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => setActive(item.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-default ${
                  active === item.id
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <span className="text-base w-5 text-center">{item.icon}</span>
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="border-t border-sidebar-border px-5 py-3">
          <p className="text-[10px] text-muted-foreground">{appVersion ? `v${appVersion}` : ""}</p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-background">
        <header className="border-b border-border bg-card px-8 py-4 shrink-0 [-webkit-app-region:drag] flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <span>{current.icon}</span>
            {current.label}
          </h2>
          <div className="[-webkit-app-region:no-drag] flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
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
