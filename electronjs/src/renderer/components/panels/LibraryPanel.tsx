import { useEffect, useState, useMemo } from "react";
import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Select } from "../common/Select";
import { Modal } from "../common/Modal";
import { EmptyState } from "../common/EmptyState";
import { ScanProgressModal } from "../modals/ScanProgressModal";
import { useLibraryStore } from "../../stores/library-store";
import {
  addLibraryFolder,
  removeLibraryFolder,
  clearContentHashes,
  pickFolder,
  getDevices,
  getDefaultDeviceId,
  getDeviceSyncedPaths,
  getPlaylists,
} from "../../ipc/api";
import type { DeviceProfile, Playlist } from "@shared/types";

type SortField =
  | "title"
  | "artist"
  | "album"
  | "genre"
  | "duration"
  | "codec"
  | "bitrate"
  | "bitsPerSample"
  | "contentType";
type SortDir = "asc" | "desc";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function formatBitrate(bps: number): string {
  if (!bps) return "—";
  const kbps = bps / 1000;
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

const columns: { field: SortField; label: string; width: string; minW?: string }[] = [
  { field: "title", label: "Title", width: "flex-[3]", minW: "120px" },
  { field: "artist", label: "Artist", width: "flex-[2]", minW: "100px" },
  { field: "album", label: "Album", width: "flex-[2]", minW: "100px" },
  { field: "genre", label: "Genre", width: "w-24", minW: "80px" },
  { field: "duration", label: "Duration", width: "w-16", minW: "56px" },
  { field: "codec", label: "Codec", width: "w-14", minW: "48px" },
  { field: "bitrate", label: "Bitrate", width: "w-20", minW: "64px" },
  { field: "bitsPerSample", label: "Bit", width: "w-12", minW: "36px" },
  { field: "contentType", label: "Type", width: "w-16", minW: "56px" },
];

export function LibraryPanel() {
  const { tracks, folders, stats, loading, fetchTracks, fetchFolders, fetchStats } =
    useLibraryStore();
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [contentType, setContentType] = useState("music");
  const [showScanProgress, setShowScanProgress] = useState(false);
  const [devices, setDevices] = useState<DeviceProfile[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [syncedPaths, setSyncedPaths] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [syncFilter, setSyncFilter] = useState<string>("all");
  const [cacheCleared, setCacheCleared] = useState<number | null>(null);
  const [libraryView, setLibraryView] = useState<"tracks" | "playlists">("tracks");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);

  useEffect(() => {
    fetchTracks();
    fetchFolders();
    fetchStats();
  }, [fetchTracks, fetchFolders, fetchStats]);

  useEffect(() => {
    if (libraryView === "playlists") {
      setPlaylistsLoading(true);
      getPlaylists()
        .then(setPlaylists)
        .catch(console.error)
        .finally(() => setPlaylistsLoading(false));
    }
  }, [libraryView]);

  useEffect(() => {
    getDevices().then(setDevices).catch(console.error);
    getDefaultDeviceId().then((id) => setSelectedDeviceId(id ?? null)).catch(console.error);
  }, []);

  useEffect(() => {
    if (selectedDeviceId == null) {
      setSyncedPaths(new Set());
      return;
    }
    getDeviceSyncedPaths(selectedDeviceId)
      .then((paths) => setSyncedPaths(new Set(paths)))
      .catch(() => setSyncedPaths(new Set()));
  }, [selectedDeviceId]);

  const filtered = useMemo(() => {
    let base = tracks;
    const q = search.trim().toLowerCase();
    if (q) {
      base = base.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      );
    }
    if (typeFilter !== "all") {
      base = base.filter((t) => t.contentType === typeFilter);
    }
    if (selectedDeviceId != null && syncFilter !== "all") {
      if (syncFilter === "synced") {
        base = base.filter((t) => syncedPaths.has(t.path));
      } else if (syncFilter === "not_synced") {
        base = base.filter((t) => !syncedPaths.has(t.path));
      }
    }
    return [...base].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      const cmp =
        typeof av === "string"
          ? (av as string).localeCompare(bv as string)
          : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [tracks, search, sortField, sortDir, typeFilter, syncFilter, selectedDeviceId, syncedPaths]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  async function handleAddFolder() {
    if (!folderName || !folderPath) return;
    await addLibraryFolder(folderName, folderPath, contentType);
    setShowAddFolder(false);
    setFolderName("");
    setFolderPath("");
    fetchFolders();
  }

  async function handleRemoveFolder(id: number) {
    await removeLibraryFolder(id);
    await Promise.all([fetchFolders(), fetchTracks(), fetchStats()]);
  }

  function handleScan() {
    if (folders.length === 0) return;
    setShowScanProgress(true);
  }

  async function handleClearCache() {
    const n = await clearContentHashes();
    setCacheCleared(n);
    setTimeout(() => setCacheCleared(null), 3000);
  }

  function handleScanClose() {
    setShowScanProgress(false);
    fetchTracks();
    fetchStats();
  }

  async function handlePickFolder() {
    const result = await pickFolder();
    if (result) setFolderPath(result);
  }

  const sortArrow = (field: SortField) =>
    sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="panel-content flex flex-col gap-5 h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => setShowAddFolder(true)}>
          + Add Folder
        </Button>
        <Button size="sm" onClick={handleScan} disabled={folders.length === 0}>
          ⟳ Scan Library
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto bg-[#ef4444] text-white hover:bg-[#dc2626] border-0"
          onClick={handleClearCache}
          title="Clear scan cache (content hashes)"
        >
          Clear scan cache
        </Button>
        {cacheCleared !== null && (
          <span className="text-xs text-[#22c55e]">Cleared {cacheCleared} hash entries</span>
        )}
        <span className="text-xs text-[#5a5f68]">
          {stats ? `${stats.totalTracks.toLocaleString()} tracks` : ""}
        </span>
      </div>

      {/* Folders */}
      {folders.length > 0 && (
        <Card title="Library Folders">
          <div className="space-y-2">
            {folders.map((f) => (
              <div key={f.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02]">
                <div className="w-7 h-7 rounded bg-[#4a9eff]/10 flex items-center justify-center text-xs text-[#4a9eff]">
                  📁
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{f.name}</p>
                  <p className="text-[10px] text-[#5a5f68] truncate">
                    {f.path} · {f.contentType}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRemoveFolder(f.id)}>
                  ✕
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Track list or empty state */}
      {folders.length === 0 && !loading ? (
        <EmptyState
          icon="📁"
          title="No library folders configured"
          description="Add a folder to start scanning your music collection"
          action={
            <Button variant="primary" size="sm" onClick={() => setShowAddFolder(true)}>
              + Add Folder
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] w-fit">
            {(["tracks", "playlists"] as const).map((view) => (
              <button
                key={view}
                type="button"
                className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${
                  libraryView === view
                    ? "bg-[#4a9eff]/15 text-[#4a9eff]"
                    : "text-[#5a5f68] hover:text-[#8a8f98]"
                }`}
                onClick={() => setLibraryView(view)}
              >
                {view}
              </button>
            ))}
          </div>

          {libraryView === "tracks" ? (
        <Card title="Tracks" className="flex-1 flex flex-col min-h-0">
          <Input
            placeholder="Search by title, artist, or album…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mb-3"
          />

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-[#5a5f68]">Device:</span>
              <Select
                options={[
                  { value: "", label: "None" },
                  ...devices.map((d) => ({ value: String(d.id), label: d.name })),
                ]}
                value={selectedDeviceId != null ? String(selectedDeviceId) : ""}
                onChange={(v) => setSelectedDeviceId(v ? Number(v) : null)}
                placeholder="None"
                className="w-40"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5f68]">Type:</span>
              <Select
                options={[
                  { value: "all", label: "All" },
                  { value: "music", label: "Music" },
                  { value: "podcast", label: "Podcast" },
                ]}
                value={typeFilter}
                onChange={(v) => setTypeFilter(v)}
                className="w-28"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#5a5f68]">On device:</span>
              <Select
                options={[
                  { value: "all", label: "All" },
                  { value: "synced", label: "Synced" },
                  { value: "not_synced", label: "Not synced" },
                ]}
                value={syncFilter}
                onChange={(v) => setSyncFilter(v)}
                placeholder="All"
                className="w-28"
                disabled={selectedDeviceId == null}
              />
            </div>
          </div>

          {/* Table with horizontal scroll */}
          <div className="flex-1 overflow-auto min-h-0 border border-white/[0.06] rounded-lg">
            <div className="min-w-[900px]">
              {/* Header */}
              <div className="theme-box flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06] sticky top-0 bg-[#131626] z-10">
                {columns.map((col) => (
                  <button
                    key={col.field}
                    className={`${col.width} shrink-0 text-left cursor-default hover:text-[#8a8f98] transition-colors`}
                    style={col.minW ? { minWidth: col.minW } : undefined}
                    onClick={() => toggleSort(col.field)}
                  >
                    {col.label}
                    {sortArrow(col.field)}
                  </button>
                ))}
                <span className="w-16 shrink-0 text-right min-w-[56px]">On device</span>
                <span className="w-16 shrink-0 text-right min-w-[56px]">Size</span>
              </div>

              {/* Rows */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="w-5 h-5 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-xs text-[#5a5f68] py-8">No tracks found</p>
              ) : (
                filtered.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] border-b border-white/[0.03] transition-colors"
                  >
                    <span className="flex-[3] min-w-[120px] truncate text-white">{t.title}</span>
                    <span className="flex-[2] min-w-[100px] truncate text-[#8a8f98]">{t.artist}</span>
                    <span className="flex-[2] min-w-[100px] truncate text-[#8a8f98]">{t.album}</span>
                    <span className="w-24 min-w-[80px] truncate text-[#5a5f68]">{t.genre}</span>
                    <span className="w-16 min-w-[56px] text-[#8a8f98] tabular-nums">
                      {formatDuration(t.duration)}
                    </span>
                    <span className="w-14 min-w-[48px] text-[#5a5f68] text-xs">{t.codec}</span>
                    <span className="w-20 min-w-[64px] text-[#5a5f68] text-xs">
                      {formatBitrate(t.bitrate)}
                    </span>
                    <span className="w-12 min-w-[36px] text-[#5a5f68] text-xs">
                      {t.bitsPerSample ? `${t.bitsPerSample}-bit` : "—"}
                    </span>
                    <span className="w-16 min-w-[56px] text-[#5a5f68] text-xs capitalize">
                      {t.contentType || "—"}
                    </span>
                    <span className="w-16 min-w-[56px] text-right text-[#22c55e]">
                      {selectedDeviceId != null && syncedPaths.has(t.path) ? "✓" : "—"}
                    </span>
                    <span className="w-16 min-w-[56px] text-right text-[#5a5f68] text-xs tabular-nums">
                      {formatSize(t.fileSize)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </Card>
          ) : (
        <Card title="Playlists" className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06]">
            <span className="flex-[3]">Name</span>
            <span className="w-24 text-right">Songs</span>
            <span className="w-28">Type</span>
          </div>
          <div className="flex-1 overflow-auto min-h-0">
            {playlistsLoading ? (
              <div className="flex justify-center py-12">
                <div className="w-5 h-5 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
              </div>
            ) : playlists.length === 0 ? (
              <p className="text-center text-xs text-[#5a5f68] py-8">No playlists</p>
            ) : (
              playlists.map((pl) => (
                <div
                  key={pl.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] border-b border-white/[0.03] transition-colors"
                >
                  <span className="flex-[3] truncate text-white font-medium">{pl.name}</span>
                  <span className="w-24 text-right text-[#8a8f98] tabular-nums">
                    {pl.trackCount}
                  </span>
                  <span className="w-28 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#4a9eff]/10 text-[#4a9eff] capitalize">
                    {pl.typeName}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
          )}
        </>
      )}

      {/* Add Folder Modal */}
      <Modal open={showAddFolder} onClose={() => setShowAddFolder(false)} title="Add Library Folder">
        <div className="space-y-4">
          <Input
            label="Name"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="My Music"
          />
          <div>
            <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">Path</label>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] placeholder:text-[#5a5f68] outline-none focus:border-[#4a9eff]/50 transition-colors"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/path/to/music"
              />
              <Button size="md" onClick={handlePickFolder}>
                Browse
              </Button>
            </div>
          </div>
          <Select
            label="Content Type"
            value={contentType}
            onChange={(v) => setContentType(v)}
            options={[
              { value: "music", label: "Music" },
              { value: "podcast", label: "Podcasts" },
            ]}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setShowAddFolder(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleAddFolder}
              disabled={!folderName || !folderPath}
            >
              Add Folder
            </Button>
          </div>
        </div>
      </Modal>

      <ScanProgressModal
        open={showScanProgress}
        onClose={handleScanClose}
        folders={folders.map((f) => ({ name: f.name, path: f.path, contentType: f.contentType }))}
      />
    </div>
  );
}
