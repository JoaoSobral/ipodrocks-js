import { useState, useEffect, type JSX } from "react";
import { getAppVersion, openExternal } from "./ipc/api";
import { WelcomePanel } from "./components/panels/WelcomePanel";
import { DashboardPanel } from "./components/panels/DashboardPanel";
import { LibraryPanel } from "./components/panels/LibraryPanel";
import { DevicePanel } from "./components/panels/DevicePanel";
import { SyncPanel } from "./components/panels/SyncPanel";
import { PlaylistPanel } from "./components/panels/PlaylistPanel";
import { AutoPodcastsPanel } from "./components/panels/AutoPodcastsPanel";
import { SettingsPanel } from "./components/panels/SettingsPanel";
import { FloatChat } from "./components/assistant/FloatChat";
import { ThemeToggle } from "./components/common/ThemeToggle";
import { PlayerBar } from "./components/player/PlayerBar";
import { useThemeStore } from "./stores/theme-store";
import { useUIStore } from "./stores/ui-store";

type Panel = "welcome" | "dashboard" | "library" | "devices" | "sync" | "playlists" | "autopodcasts";

interface NavItem {
  id: Panel;
  label: string;
  icon: JSX.Element;
}

const navItems: NavItem[] = [
  {
    id: "welcome",
    label: "Welcome",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M1 10V2l9 3v2zm7 0V8h5V4H8V3l4-2l4 2v1h-1v4h1v2h-1.26l-6.3 3.64L9 10zM7 23l.04-.24l9.11-5.26l.52 3.38L13 23zm1.05-6.83L15.31 12l.52 3.37l-8.4 4.85z" />
      </svg>
    ),
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 16V4H3v12zm0-14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7v2h2v2H8v-2h2v-2H3a2 2 0 0 1-2-2V4c0-1.11.89-2 2-2zM5 6h9v5H5zm10 0h4v2h-4zm4 3v5h-4V9zM5 12h4v2H5zm5 0h4v2h-4z" />
      </svg>
    ),
  },
  {
    id: "library",
    label: "Library",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21 3v12.5a3.5 3.5 0 0 1-3.5 3.5a3.5 3.5 0 0 1-3.5-3.5a3.5 3.5 0 0 1 3.5-3.5c.54 0 1.05.12 1.5.34V6.47L9 8.6v8.9A3.5 3.5 0 0 1 5.5 21A3.5 3.5 0 0 1 2 17.5A3.5 3.5 0 0 1 5.5 14c.54 0 1.05.12 1.5.34V6z" />
      </svg>
    ),
  },
  {
    id: "playlists",
    label: "Playlists",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M15 6v2H3V6zm0 4v2H3v-2zM3 16v-2h8v2zM17 6h5v2h-3v9a3 3 0 0 1-3 3a3 3 0 0 1-3-3a3 3 0 0 1 3-3c.35 0 .69.07 1 .18zm-1 10a1 1 0 0 0-1 1a1 1 0 0 0 1 1a1 1 0 0 0 1-1a1 1 0 0 0-1-1" />
      </svg>
    ),
  },
  {
    id: "autopodcasts",
    label: "Auto Podcasts",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 18.25v3.25H7v-3.25c0-1.38 2.24-2.5 5-2.5s5 1.12 5 2.5M12 5.5a6.5 6.5 0 0 1 6.5 6.5c0 1.25-.35 2.42-.96 3.41L16 14.04c.32-.61.5-1.31.5-2.04c0-2.5-2-4.5-4.5-4.5s-4.5 2-4.5 4.5c0 .73.18 1.43.5 2.04l-1.54 1.37c-.61-.99-.96-2.16-.96-3.41A6.5 6.5 0 0 1 12 5.5m0-4A10.5 10.5 0 0 1 22.5 12c0 2.28-.73 4.39-1.96 6.11l-1.5-1.35c.92-1.36 1.46-3 1.46-4.76A8.5 8.5 0 0 0 12 3.5A8.5 8.5 0 0 0 3.5 12c0 1.76.54 3.4 1.46 4.76l-1.5 1.35A10.47 10.47 0 0 1 1.5 12A10.5 10.5 0 0 1 12 1.5m0 8a2.5 2.5 0 0 1 2.5 2.5a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 9.5 12A2.5 2.5 0 0 1 12 9.5" />
      </svg>
    ),
  },
  {
    id: "devices",
    label: "Devices",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 2h10v6H7zm5 8a4 4 0 0 1 4 4a4 4 0 0 1-4 4a4 4 0 0 1-4-4a4 4 0 0 1 4-4m0 2a2 2 0 0 0-2 2a2 2 0 0 0 2 2a2 2 0 0 0 2-2a2 2 0 0 0-2-2" />
      </svg>
    ),
  },
  {
    id: "sync",
    label: "Sync",
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2 12A10 10 0 1 0 12 2A10 10 0 0 0 2 12m13.6 1.72A4 4 0 0 0 16 12a4 4 0 0 0-4-4v2L8.88 7L12 4v2a6 6 0 0 1 6 6a5.9 5.9 0 0 1-.93 3.19M6 12a5.9 5.9 0 0 1 .93-3.19l1.47 1.47A4 4 0 0 0 8 12a4 4 0 0 0 4 4v-2l3 3l-3 3v-2a6 6 0 0 1-6-6" />
      </svg>
    ),
  },
];

const panels: Record<Panel, () => JSX.Element> = {
  welcome: WelcomePanel,
  dashboard: DashboardPanel,
  library: LibraryPanel,
  devices: DevicePanel,
  sync: SyncPanel,
  playlists: PlaylistPanel,
  autopodcasts: AutoPodcastsPanel,
};

const SHOW_THEME_TOGGLE: Panel[] = [
  "welcome",
  "dashboard",
  "library",
  "devices",
  "sync",
  "playlists",
  "autopodcasts",
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
                <span className="w-5 h-5 flex items-center justify-center shrink-0">{item.icon}</span>
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
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden bg-background">
        <header className="border-b border-border bg-card px-8 py-4 shrink-0 [-webkit-app-region:drag] flex items-center justify-between">
          <h2 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <span>{current.icon}</span>
            {current.label}
          </h2>
          <div className="[-webkit-app-region:no-drag] flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-default"
              title="Settings"
              aria-label="Settings"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M8.999 3.999a4.002 4.002 0 0 0 0 8.003a3.999 3.999 0 0 0 3.998-4.005A3.998 3.998 0 0 0 9 4zm0 10C6.329 13.999 1 15.332 1 17.997V20H12.08a6.233 6.233 0 0 1-.078-1.001c0-1.514.493-2.988 1.407-4.199c-1.529-.523-3.228-.801-4.41-.801zm8.99 0a.261.261 0 0 0-.25.21l-.19 1.319a4.091 4.091 0 0 0-.85.492l-1.24-.502a.265.265 0 0 0-.308.112l-1.001 1.729a.255.255 0 0 0 .059.322l1.06.83a3.95 3.95 0 0 0 0 .981l-1.06.83a.26.26 0 0 0-.059.318l1.001 1.729c.059.111.19.151.308.111l1.24-.497c.258.2.542.366.85.488l.19 1.318c.02.122.122.21.25.21h2.001c.122 0 .23-.088.25-.21l.19-1.318c.297-.132.59-.288.84-.488l1.25.497c.111.04.239 0 .313-.111l.996-1.729a.256.256 0 0 0-.059-.317l-1.07-.83c.02-.162.04-.323.04-.494c0-.171-.01-.328-.04-.488l1.06-.83c.087-.084.121-.21.059-.322l-.996-1.729a.263.263 0 0 0-.313-.113l-1.24.503c-.26-.2-.543-.37-.85-.492l-.19-1.32a.238.238 0 0 0-.24-.21M18.989 17.5c.83 0 1.5.669 1.5 1.499c0 .83-.67 1.498-1.5 1.498S17.49 19.83 17.49 19s.669-1.499 1.499-1.499z" />
              </svg>
            </button>
            {showThemeToggle && <ThemeToggle />}
            <div className="w-px h-4 bg-border mx-1" />
            <button
              type="button"
              onClick={() => openExternal("https://github.com/JoaoSobral/ipodrocks-js")}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-default"
              title="iPodRocks on GitHub"
              aria-label="iPodRocks on GitHub"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2" />
              </svg>
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-auto px-8 py-6">
          {(() => {
            const ActivePanel = panels[active];
            return <ActivePanel />;
          })()}
        </div>
        <PlayerBar />
      </main>

      <FloatChat />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
