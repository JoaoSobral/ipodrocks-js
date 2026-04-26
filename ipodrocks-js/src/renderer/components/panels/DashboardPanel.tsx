import { useEffect, useState } from "react";
import { Card } from "../common/Card";
import { InfoTooltip } from "../common/InfoTooltip";
import { ListRow } from "../common/ListRow";
import { useLibraryStore } from "../../stores/library-store";
import { useDeviceStore } from "../../stores/device-store";
import { getShadowLibraries, getRecentActivity } from "../../ipc/api";
import { getDeviceIconSrc } from "../../utils/device-icon";
import type { ShadowLibrary } from "@shared/types";
import type { ActivityEntry } from "../../ipc/api";

function formatBytes(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function Skeleton({ className = "w-24" }: { className?: string }) {
  return <div className={`h-4 rounded bg-muted animate-pulse ${className}`} />;
}

function statusLabel(status: ShadowLibrary["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "building":
      return "Building";
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

  const deviceList = Array.isArray(devices) ? devices : [];
  const shadowList = Array.isArray(shadowLibs) ? shadowLibs : [];

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

  return (
    <div className="panel-content grid grid-cols-2 gap-5 h-full grid-rows-[auto_auto_1fr]">
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
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
                  {d ? (
                    <img
                      src={getDeviceIconSrc(d, deviceList)}
                      alt={d.modelName ?? "Device"}
                      className="w-full h-full object-contain"
                    />
                  ) : null}
                </div>
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

      {/* Recent Activity */}
      <Card title="Recent Activity" subtitle="Last 100 operations" className="col-span-2 flex flex-col min-h-0">
        {activity.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-xs text-muted-foreground">No recent activity</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5">
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
