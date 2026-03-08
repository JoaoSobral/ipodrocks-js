import { useEffect } from "react";
import { Card } from "../common/Card";
import { useLibraryStore } from "../../stores/library-store";
import { useDeviceStore } from "../../stores/device-store";

function formatBytes(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function Skeleton({ className = "w-24" }: { className?: string }) {
  return <div className={`h-4 rounded bg-white/[0.06] animate-pulse ${className}`} />;
}

export function DashboardPanel() {
  const { stats, fetchStats, loading: libLoading } = useLibraryStore();
  const { devices, fetchDevices, loading: devLoading } = useDeviceStore();

  useEffect(() => {
    fetchStats();
    fetchDevices();
  }, [fetchStats, fetchDevices]);

  return (
    <div className="panel-content grid grid-cols-2 gap-5">
      {/* Library Stats */}
      <Card title="Library" subtitle="Collection overview">
        {libLoading || !stats ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="w-32" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Tracks", value: stats.totalTracks.toLocaleString(), icon: "♫" },
              { label: "Albums", value: stats.totalAlbums.toLocaleString(), icon: "◉" },
              { label: "Artists", value: stats.totalArtists.toLocaleString(), icon: "♪" },
              { label: "Total Size", value: formatBytes(stats.totalSizeBytes), icon: "⊡" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-[#4a9eff]/[0.08] flex items-center justify-center text-sm text-[#4a9eff]">
                  {item.icon}
                </div>
                <div>
                  <p className="text-base font-semibold text-white leading-tight">{item.value}</p>
                  <p className="text-[10px] text-[#5a5f68]">{item.label}</p>
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
        ) : devices.length === 0 ? (
          <p className="text-xs text-[#5a5f68]">No devices configured</p>
        ) : (
          <div className="space-y-3">
            {devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02] [.theme-light_&]:bg-[#f3f4f6]"
              >
                <div className="w-8 h-8 rounded-lg bg-[#22c55e]/10 flex items-center justify-center text-sm text-[#22c55e] shrink-0">
                  ⊞
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate [.theme-light_&]:text-[#1a1a1a]">
                    {d.name}
                  </p>
                  <div className="text-[10px] text-[#5a5f68] [.theme-light_&]:text-[#6b7280] space-y-0.5 mt-0.5">
                    <p>
                      {d.lastSyncDate
                        ? `Last sync: ${new Date(d.lastSyncDate).toLocaleDateString()}`
                        : "Never synced"}
                    </p>
                    <p>{d.totalSyncedItems.toLocaleString()} tracks synced</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Recent Activity */}
      <Card title="Recent Activity" subtitle="Latest operations" className="col-span-2">
        <div className="flex items-center justify-center py-8">
          <p className="text-xs text-[#5a5f68]">No recent activity</p>
        </div>
      </Card>
    </div>
  );
}
