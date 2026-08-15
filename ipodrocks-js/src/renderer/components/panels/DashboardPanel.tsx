import { useEffect, useMemo, useState } from "react";
import { Card } from "../common/Card";
import { DeviceIcon } from "../common/DeviceIcon";
import { InfoTooltip } from "../common/InfoTooltip";
import { ListRow } from "../common/ListRow";
import { Button } from "../common/Button";
import { useLibraryStore } from "../../stores/library-store";
import { useDeviceStore } from "../../stores/device-store";
import { getShadowLibraries, getRecentActivity, getListeningStats } from "../../ipc/api";
import { createDeviceIconResolver } from "../../utils/device-icon";
import { safeLocalStorage } from "../../utils/storage";
import type { ShadowLibrary, ListeningStats, ListeningStatsPeriod } from "@shared/types";
import type { ActivityEntry } from "../../ipc/api";

const CLOCK_WARNING_DISMISSED_KEY = "ipodrocks-dashboard-clock-warning-dismissed";

function formatBytes(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function formatListeningTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

const PERIOD_LABELS: Record<ListeningStatsPeriod, string> = {
  all: "All Time",
  year: "This Year",
  month: "This Month",
};

function Skeleton({ className = "w-24" }: { className?: string }) {
  return <div className={`h-4 rounded bg-muted animate-pulse ${className}`} />;
}

function statusLabel(status: ShadowLibrary["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "building":
      return "Building";
    case "paused":
      return "Paused";
    case "pending":
      return "Pending";
    case "error":
      return "Error";
    default:
      return status;
  }
}

function statusColor(status: ShadowLibrary["status"]): string {
  switch (status) {
    case "ready":
      return "text-success";
    case "building":
    case "paused":
      return "text-warning";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

const OPERATION_LABELS: Record<string, string> = {
  sync: "Sync",
  library_scan: "Library scan",
  add_folder: "Add folder",
  add_device: "Add device",
  update_device: "Update device",
  read_playback_log: "Read playback log",
  playlist_generated: "Playlist generated",
};

function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

export function DashboardPanel() {
  const stats = useLibraryStore((s) => s.stats);
  const folders = useLibraryStore((s) => s.folders);
  const fetchStats = useLibraryStore((s) => s.fetchStats);
  const fetchFolders = useLibraryStore((s) => s.fetchFolders);
  const libError = useLibraryStore((s) => s.error);
  const devices = useDeviceStore((s) => s.devices);
  const fetchDevices = useDeviceStore((s) => s.fetchDevices);
  const devLoading = useDeviceStore((s) => s.loading);
  const [shadowLibs, setShadowLibs] = useState<ShadowLibrary[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [libraryReady, setLibraryReady] = useState(false);
  const [statsPeriod, setStatsPeriod] = useState<ListeningStatsPeriod>("year");
  const [listeningStats, setListeningStats] = useState<ListeningStats | null>(null);
  const [clockWarningDismissed, setClockWarningDismissed] = useState(
    () => safeLocalStorage()?.getItem(CLOCK_WARNING_DISMISSED_KEY) === "true"
  );
  const dismissClockWarning = () => {
    safeLocalStorage()?.setItem(CLOCK_WARNING_DISMISSED_KEY, "true");
    setClockWarningDismissed(true);
  };

  const deviceList = Array.isArray(devices) ? devices : [];
  const shadowList = Array.isArray(shadowLibs) ? shadowLibs : [];
  const resolveDeviceIcon = useMemo(
    () => createDeviceIconResolver(deviceList.filter((d): d is NonNullable<typeof d> => d != null)),
    [deviceList],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([fetchStats(), fetchFolders()]).finally(() => {
      if (!cancelled) setLibraryReady(true);
    });
    fetchDevices();
    getShadowLibraries().then(setShadowLibs).catch(console.error);
    getRecentActivity().then(setActivity).catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [fetchStats, fetchFolders, fetchDevices]);

  useEffect(() => {
    let cancelled = false;
    setListeningStats(null);
    getListeningStats(statsPeriod)
      .then((s) => {
        if (!cancelled) setListeningStats(s);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [statsPeriod]);

  return (
    <div className="panel-content grid grid-cols-2 gap-5">
      {/* Library Stats */}
      <Card title="Library" subtitle="Collection overview">
        {!libraryReady ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="w-32" />
            ))}
          </div>
        ) : folders.length === 0 ? (
          <p className="text-xs text-muted-foreground">No library configured</p>
        ) : !stats ? (
          <p className="text-xs text-destructive">
            {libError ?? "Unable to load library stats."}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {[
              {
                label: "Tracks",
                value: (stats?.totalTracks ?? 0).toLocaleString(),
                icon: "♫",
              },
              {
                label: "Albums",
                value: (stats?.totalAlbums ?? 0).toLocaleString(),
                icon: "◉",
              },
              {
                label: "Artists",
                value: (stats?.totalArtists ?? 0).toLocaleString(),
                icon: "♪",
              },
              {
                label: "Total Size",
                value: formatBytes(stats?.totalSizeBytes ?? 0),
                icon: "⊡",
              },
              {
                label: "Podcasts",
                value: (stats?.podcastTrackCount ?? 0).toLocaleString(),
                icon: "🎙",
              },
              {
                label: "Audiobooks",
                value: (stats?.audiobookTrackCount ?? 0).toLocaleString(),
                icon: "📖",
              },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-sm text-primary">
                  {item.icon}
                </div>
                <div>
                  <p className="text-base font-semibold text-foreground leading-tight">
                    {item.value}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{item.label}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Devices */}
      <Card title="Devices" subtitle="Connected devices">
        {devLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="w-40" />
            ))}
          </div>
        ) : deviceList.length === 0 ? (
          <p className="text-xs text-muted-foreground">No devices configured</p>
        ) : (
          <div className="space-y-3">
            {deviceList.map((d, i) => (
              <ListRow key={d?.id ?? `device-${i}`}>
                <DeviceIcon
                  src={d ? resolveDeviceIcon(d) : null}
                  alt={d?.modelName ?? "Device"}
                  size="sm"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {d?.name ?? "Unknown device"}
                  </p>
                  <div className="text-[10px] text-muted-foreground space-y-0.5 mt-0.5">
                    <p>
                      {d?.lastSyncDate
                        ? `Last sync: ${new Date(d.lastSyncDate).toLocaleDateString()}`
                        : "Never synced"}
                    </p>
                    <p>
                      {(d?.totalSyncedItems ?? 0).toLocaleString()} total ·{" "}
                      {(d?.lastSyncCount ?? 0).toLocaleString()} in last sync
                    </p>
                  </div>
                </div>
              </ListRow>
            ))}
          </div>
        )}
      </Card>

      {/* Shadow Libraries */}
      <Card
        title={<span className="inline-flex items-center gap-1.5">Shadow Libraries <InfoTooltip text="A pre-transcoded copy of your library at a target codec and bitrate. Devices can sync directly from a shadow library instead of converting files in real time." /></span>}
        subtitle="Pre-transcoded library mirrors"
        className="col-span-2"
      >
        {shadowList.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No shadow libraries. Create one from the Library panel.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {shadowList.map((sl, i) => (
              <ListRow key={sl?.id ?? `shadow-${i}`}>
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-sm text-primary shrink-0">
                  ◐
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {sl?.name ?? "Unnamed"}
                  </p>
                  <div className="text-[10px] text-muted-foreground space-y-0.5 mt-0.5">
                    <p className="truncate" title={sl?.path}>
                      {sl?.codecName ?? "—"} · {(sl?.trackCount ?? 0).toLocaleString()} tracks
                      {typeof sl?.totalBytes === "number" && sl.totalBytes > 0
                        ? ` · ${formatBytes(sl.totalBytes)}`
                        : ""}
                    </p>
                    <p className={statusColor(sl?.status ?? "pending")}>
                      {statusLabel(sl?.status ?? "pending")}
                    </p>
                  </div>
                </div>
              </ListRow>
            ))}
          </div>
        )}
      </Card>

      {/* Listening Stats */}
      <Card
        title="Listening Stats"
        subtitle="From your device playback history"
        className="col-span-2"
        action={
          <div className="flex gap-1">
            {(Object.keys(PERIOD_LABELS) as ListeningStatsPeriod[]).map((p) => (
              <Button
                key={p}
                variant={statsPeriod === p ? "primary" : "ghost"}
                size="sm"
                onClick={() => setStatsPeriod(p)}
              >
                {PERIOD_LABELS[p]}
              </Button>
            ))}
          </div>
        }
      >
        {!listeningStats ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="w-32" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {listeningStats.totalMatchedPlays > 0 &&
              !listeningStats.clockValid &&
              !clockWarningDismissed && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-warning/30 bg-warning/10 text-[11px]">
                  <span className="text-warning shrink-0">⚠</span>
                  <span className="text-warning flex-1 min-w-0">
                    Found {listeningStats.totalMatchedPlays.toLocaleString()} logged play
                    {listeningStats.totalMatchedPlays === 1 ? "" : "s"}, but your device's clock
                    isn't set — Rockbox is reporting dates from the year 2000. Set the date & time
                    on your device (Settings → General → Time & Date) and new plays will start
                    counting toward your stats.
                  </span>
                  <Button variant="ghost" size="sm" onClick={dismissClockWarning}>
                    Dismiss
                  </Button>
                </div>
              )}
            {listeningStats.totalPlays === 0 ? (
              <p className="text-xs text-muted-foreground">
                No listening data yet. Playback logs are read from Rockbox devices during sync.
              </p>
            ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Plays", value: listeningStats.totalPlays.toLocaleString(), icon: "▶" },
                {
                  label: "Listening Time",
                  value: formatListeningTime(listeningStats.totalListeningTimeMs),
                  icon: "⏱",
                },
                { label: "Top Genre", value: listeningStats.topGenre?.name ?? "—", icon: "🎼" },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-sm text-primary">
                    {item.icon}
                  </div>
                  <div>
                    <p className="text-base font-semibold text-foreground leading-tight">
                      {item.value}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{item.label}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="text-xs font-semibold text-foreground mb-2">Top Tracks</p>
                <div className="space-y-1.5">
                  {listeningStats.topTracks.map((t, i) => {
                    const max = listeningStats.topTracks[0]?.playCount || 1;
                    return (
                      <div key={t.trackId} className="text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-foreground">
                            {i + 1}. {t.title}{" "}
                            <span className="text-muted-foreground">— {t.artist}</span>
                          </span>
                          <span className="text-muted-foreground shrink-0">{t.playCount}</span>
                        </div>
                        <div className="h-1 rounded-full bg-muted mt-0.5 overflow-hidden">
                          <div
                            className="h-full bg-primary/60 rounded-full"
                            style={{ width: `${(t.playCount / max) * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-foreground mb-2">Top Artists</p>
                <div className="space-y-1.5">
                  {listeningStats.topArtists.map((a, i) => {
                    const max = listeningStats.topArtists[0]?.playCount || 1;
                    return (
                      <div key={`${a.name}-${i}`} className="text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-foreground">
                            {i + 1}. {a.name}
                          </span>
                          <span className="text-muted-foreground shrink-0">{a.playCount}</span>
                        </div>
                        <div className="h-1 rounded-full bg-muted mt-0.5 overflow-hidden">
                          <div
                            className="h-full bg-primary/60 rounded-full"
                            style={{ width: `${(a.playCount / max) * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
            )}
          </div>
        )}
      </Card>

      {/* Recent Activity */}
      <Card title="Recent Activity" subtitle="Last 100 operations" className="col-span-2">
        {activity.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-xs text-muted-foreground">No recent activity</p>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto space-y-1.5">
            {activity.map((entry) => (
              <ListRow key={entry.id} className="justify-between py-1.5 px-2.5 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-primary shrink-0">
                    {OPERATION_LABELS[entry.operation] ?? entry.operation}
                  </span>
                  {entry.detail && (
                    <span className="text-muted-foreground truncate">
                      {entry.detail}
                    </span>
                  )}
                </div>
                <span className="text-muted-foreground shrink-0">
                  {formatActivityTime(entry.created_at)}
                </span>
              </ListRow>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
