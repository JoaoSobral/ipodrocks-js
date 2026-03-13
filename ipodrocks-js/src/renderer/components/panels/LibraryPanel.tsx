import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { FixedSizeList as List } from "react-window";
import { formatDuration, formatSize, formatBitrate, formatShadowCodecLabel, formatShadowCodecAndBitrate, formatShadowSize } from "../../utils/format";
import { getTranscodableCodecConfigs } from "../../utils/codec";
import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Select } from "../common/Select";
import { Modal } from "../common/Modal";
import { ProgressBar } from "../common/ProgressBar";
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
  getCodecConfigs,
  getShadowLibraries,
  createShadowLibrary,
  deleteShadowLibrary,
  rebuildShadowLibrary,
  cancelShadowBuild,
  onShadowBuildProgress,
  isMpcencAvailable,
  getMpcRemindDisabled,
  setMpcRemindDisabled,
} from "../../ipc/api";
import { MpcUnavailableModal } from "../modals/MpcUnavailableModal";
import type { CodecConfig } from "../../ipc/api";
import type { DeviceProfile, Playlist, ShadowLibrary, ShadowBuildProgress } from "@shared/types";

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
  const tracks = useLibraryStore((s) => s.tracks);
  const folders = useLibraryStore((s) => s.folders);
  const stats = useLibraryStore((s) => s.stats);
  const loading = useLibraryStore((s) => s.loading);
  const fetchTracks = useLibraryStore((s) => s.fetchTracks);
  const fetchFolders = useLibraryStore((s) => s.fetchFolders);
  const fetchStats = useLibraryStore((s) => s.fetchStats);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [contentType, setContentType] = useState("music");
  const [showScanProgress, setShowScanProgress] = useState(false);
  const [foldersToScan, setFoldersToScan] = useState<
    Array<{ name: string; path: string; contentType: string }> | null
  >(null);
  const [devices, setDevices] = useState<DeviceProfile[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [syncedPaths, setSyncedPaths] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [syncFilter, setSyncFilter] = useState<string>("all");
  const [cacheCleared, setCacheCleared] = useState<number | null>(null);
  const [libraryView, setLibraryView] = useState<"tracks" | "playlists">("tracks");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(false);

  const [shadowLibs, setShadowLibs] = useState<ShadowLibrary[]>([]);
  const [showCreateShadow, setShowCreateShadow] = useState(false);
  const [shadowName, setShadowName] = useState("");
  const [shadowPath, setShadowPath] = useState("");
  const [shadowCodecConfigId, setShadowCodecConfigId] = useState<number | null>(null);
  const [codecConfigs, setCodecConfigs] = useState<CodecConfig[]>([]);
  const [shadowBuildProgress, setShadowBuildProgress] = useState<ShadowBuildProgress | null>(null);
  const [showShadowBuild, setShowShadowBuild] = useState(false);
  const [shadowBuildLogs, setShadowBuildLogs] = useState<
    { message: string; level: ShadowBuildProgress["logLevel"] }[]
  >([]);
  const shadowLogRef = useRef<HTMLDivElement>(null);
  const shadowBuildUnsubRef = useRef<(() => void) | null>(null);
  const [mpcAvailable, setMpcAvailable] = useState(true);
  const [mpcRemindDisabled, setMpcRemindDisabledState] = useState(false);
  const [showMpcModal, setShowMpcModal] = useState(false);
  const [shadowDeleteModal, setShadowDeleteModal] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [keepFilesWhenDelete, setKeepFilesWhenDelete] = useState(false);

  const addShadowLog = useCallback(
    (message: string, level: ShadowBuildProgress["logLevel"]) => {
      setShadowBuildLogs((prev) => {
        const next = [...prev, { message, level }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    },
    []
  );

  useEffect(() => {
    if (shadowLogRef.current) {
      shadowLogRef.current.scrollTop = shadowLogRef.current.scrollHeight;
    }
  }, [shadowBuildLogs]);

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
    getShadowLibraries().then(setShadowLibs).catch(console.error);
    getCodecConfigs().then(setCodecConfigs).catch(console.error);
    isMpcencAvailable().then((r) => setMpcAvailable(r.available)).catch(() => setMpcAvailable(false));
    getMpcRemindDisabled().then((r) => setMpcRemindDisabledState(r.disabled)).catch(console.error);
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

  useEffect(() => {
    if (!showCreateShadow) return;
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const hasMpc = configs.some((c) => (c?.codec_name ?? "").toUpperCase() === "MPC");
    if (hasMpc && !mpcAvailable && !mpcRemindDisabled) {
      setShowMpcModal(true);
    }
  }, [showCreateShadow, codecConfigs, mpcAvailable, mpcRemindDisabled]);

  const filtered = useMemo(() => {
    let base = Array.isArray(tracks) ? tracks : [];
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
    const name = folderName.trim();
    const pathVal = folderPath.trim();
    const type = contentType;
    await addLibraryFolder(name, pathVal, type);
    setShowAddFolder(false);
    setFolderName("");
    setFolderPath("");
    fetchFolders();
    setFoldersToScan([{ name, path: pathVal, contentType: type }]);
    setShowScanProgress(true);
  }

  async function handleRemoveFolder(id: number) {
    await removeLibraryFolder(id);
    await Promise.all([fetchFolders(), fetchTracks(), fetchStats()]);
  }

  function handleScan() {
    if (folders.length === 0) return;
    setFoldersToScan(null);
    setShowScanProgress(true);
  }

  async function handleClearCache() {
    const n = await clearContentHashes();
    setCacheCleared(n);
    setTimeout(() => setCacheCleared(null), 3000);
  }

  function handleScanClose() {
    setShowScanProgress(false);
    setFoldersToScan(null);
    fetchTracks();
    fetchStats();
  }

  async function handlePickFolder() {
    const result = await pickFolder();
    if (result) setFolderPath(result);
  }

  async function handlePickShadowPath() {
    const result = await pickFolder();
    if (result) setShadowPath(result);
  }

  const transcodableCodecConfigs = useMemo(
    () => getTranscodableCodecConfigs(codecConfigs, mpcAvailable),
    [codecConfigs, mpcAvailable]
  );

  async function handleCreateShadow() {
    if (!shadowName || !shadowPath || shadowCodecConfigId == null) return;
    setShowCreateShadow(false);
    setShowShadowBuild(true);
    setShadowBuildProgress(null);
    setShadowBuildLogs([]);

    const unsub = onShadowBuildProgress((p) => {
      setShadowBuildProgress(p);
      if (p.logMessage) {
        addShadowLog(p.logMessage, p.logLevel ?? "info");
      } else if (p.currentFile) {
        addShadowLog(`Converting: ${p.currentFile}`, "info");
      }
      if (
        p.status === "complete" ||
        p.status === "error" ||
        p.status === "cancelled"
      ) {
        shadowBuildUnsubRef.current?.();
        shadowBuildUnsubRef.current = null;
      }
    });
    shadowBuildUnsubRef.current = unsub;
    try {
      await createShadowLibrary(shadowName, shadowPath, shadowCodecConfigId);
    } catch (err) {
      console.error("Shadow create error:", err);
    }
    setShadowName("");
    setShadowPath("");
    setShadowCodecConfigId(null);
    getShadowLibraries().then(setShadowLibs).catch(console.error);
  }

  function openDeleteShadowModal(sl: ShadowLibrary) {
    setShadowDeleteModal({ id: sl.id, name: sl.name });
    setKeepFilesWhenDelete(false);
  }

  async function confirmDeleteShadow() {
    if (!shadowDeleteModal) return;
    await deleteShadowLibrary(shadowDeleteModal.id, keepFilesWhenDelete);
    setShadowDeleteModal(null);
    getShadowLibraries().then(setShadowLibs).catch(console.error);
  }

  async function handleRebuildShadow(id: number) {
    setShowShadowBuild(true);
    setShadowBuildProgress(null);
    setShadowBuildLogs([]);

    const unsub = onShadowBuildProgress((p) => {
      setShadowBuildProgress(p);
      if (p.logMessage) {
        addShadowLog(p.logMessage, p.logLevel ?? "info");
      } else if (p.currentFile) {
        addShadowLog(`Converting: ${p.currentFile}`, "info");
      }
      if (
        p.status === "complete" ||
        p.status === "error" ||
        p.status === "cancelled"
      ) {
        shadowBuildUnsubRef.current?.();
        shadowBuildUnsubRef.current = null;
      }
    });
    shadowBuildUnsubRef.current = unsub;
    try {
      await rebuildShadowLibrary(id);
    } catch (err) {
      console.error("Shadow rebuild error:", err);
    }
    getShadowLibraries().then(setShadowLibs).catch(console.error);
  }

  function handleCancelShadowBuild() {
    cancelShadowBuild().catch(console.error);
  }

  const sortArrow = (field: SortField) =>
    sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="panel-content flex flex-col gap-5 h-full min-h-0 overflow-y-auto">
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

      {/* Shadow Libraries */}
      <Card title="Shadow Libraries">
        {shadowLibs.length === 0 ? (
          <p className="text-xs text-[#5a5f68] mb-3">
            No shadow libraries yet. Create one to pre-transcode your library.
          </p>
        ) : (
          <div className="space-y-2 mb-3">
            {shadowLibs.map((sl) => (
              <div
                key={sl.id}
                className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02]"
              >
                <div className="w-7 h-7 rounded bg-[#a855f7]/10 flex items-center justify-center text-xs text-[#a855f7]">
                  ◈
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-white truncate">
                      {sl.name} ({formatShadowCodecAndBitrate(sl)})
                    </p>
                    <span
                      className={`px-1.5 py-0.5 text-[9px] font-medium rounded shrink-0 ${
                        sl.status === "ready"
                          ? "bg-[#22c55e]/15 text-[#22c55e]"
                          : sl.status === "building"
                            ? "bg-[#f5bf42]/15 text-[#f5bf42]"
                            : sl.status === "error"
                              ? "bg-[#ef4444]/15 text-[#ef4444]"
                              : "bg-white/10 text-[#8a8f98]"
                      }`}
                    >
                      {sl.status === "ready"
                        ? "Synced"
                        : sl.status === "building"
                          ? "Building"
                          : sl.status.toUpperCase()}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#5a5f68] truncate">
                    {sl.path} · {sl.trackCount} tracks · {formatShadowSize(sl.totalBytes)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRebuildShadow(sl.id)}
                    title="Rebuild"
                  >
                    ⟳
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDeleteShadowModal(sl)}
                    title="Delete"
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowCreateShadow(true)}
        >
          + Create Shadow Library
        </Button>
      </Card>

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
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] w-fit shrink-0">
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
        <Card title="Tracks" className="flex-1 flex flex-col min-h-[400px] min-w-0 overflow-hidden">
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
                  ...(Array.isArray(devices) ? devices : []).map((d) => ({
                    value: String(d.id),
                    label: d.name,
                  })),
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
                  { value: "audiobook", label: "Audiobook" },
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

          {/* Table with horizontal scroll — contained so list and scrollbar stay inside card */}
          <div className="flex-1 min-h-[100px] overflow-auto border border-white/[0.06] rounded-lg bg-[#131626] [.theme-light_&]:bg-white [.theme-light_&]:border-[#dadce0] mt-2.5">
            <div className="min-w-[900px]">
              {/* Header */}
              <div className="theme-box flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06] sticky top-0 bg-[#131626] z-10 [.theme-light_&]:bg-[#f8f9fa] [.theme-light_&]:text-[#202124] [.theme-light_&]:border-[#dadce0]">
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
                <List
                  height={400}
                  itemCount={filtered.length}
                  itemSize={40}
                  width="100%"
                  className="scrollbar-thin"
                >
                  {({ index, style }) => {
                    const t = filtered[index];
                    return (
                      <div
                        style={style}
                        className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] [.theme-light_&]:hover:bg-[#f1f3f4] border-b border-white/[0.03] [.theme-light_&]:border-[#e8eaed] transition-colors"
                      >
                        <span className="flex-[3] min-w-[120px] truncate text-white [.theme-light_&]:text-[#202124]">{t.title}</span>
                        <span className="flex-[2] min-w-[100px] truncate text-[#8a8f98] [.theme-light_&]:text-[#5f6368]">{t.artist}</span>
                        <span className="flex-[2] min-w-[100px] truncate text-[#8a8f98] [.theme-light_&]:text-[#5f6368]">{t.album}</span>
                        <span className="w-24 min-w-[80px] truncate text-[#5a5f68] [.theme-light_&]:text-[#5f6368]">{t.genre}</span>
                        <span className="w-16 min-w-[56px] text-[#8a8f98] [.theme-light_&]:text-[#5f6368] tabular-nums">
                          {formatDuration(t.duration)}
                        </span>
                        <span className="w-14 min-w-[48px] text-[#5a5f68] [.theme-light_&]:text-[#5f6368] text-xs">{t.codec}</span>
                        <span className="w-20 min-w-[64px] text-[#5a5f68] [.theme-light_&]:text-[#5f6368] text-xs">
                          {formatBitrate(t.bitrate)}
                        </span>
                        <span className="w-12 min-w-[36px] text-[#5a5f68] [.theme-light_&]:text-[#5f6368] text-xs">
                          {t.bitsPerSample ? `${t.bitsPerSample}-bit` : "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-[#5a5f68] [.theme-light_&]:text-[#5f6368] text-xs capitalize">
                          {t.contentType || "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-right text-[#22c55e]">
                          {selectedDeviceId != null && syncedPaths.has(t.path) ? "✓" : "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-right text-[#5a5f68] [.theme-light_&]:text-[#5f6368] text-xs tabular-nums">
                          {formatSize(t.fileSize)}
                        </span>
                      </div>
                    );
                  }}
                </List>
              )}
            </div>
          </div>
        </Card>
          ) : (
        <Card title="Playlists" className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06] [.theme-light_&]:bg-[#f8f9fa] [.theme-light_&]:text-[#202124] [.theme-light_&]:border-[#dadce0]">
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
              <p className="text-center text-xs text-[#5a5f68] [.theme-light_&]:text-[#5f6368] py-8">No playlists</p>
            ) : (
              playlists.map((pl) => (
                <div
                  key={pl.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] [.theme-light_&]:hover:bg-[#f1f3f4] border-b border-white/[0.03] [.theme-light_&]:border-[#e8eaed] transition-colors"
                >
                  <span className="flex-[3] truncate text-white font-medium [.theme-light_&]:text-[#202124]">{pl.name}</span>
                  <span className="w-24 text-right text-[#8a8f98] [.theme-light_&]:text-[#5f6368] tabular-nums">
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
        </div>
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
              { value: "audiobook", label: "Audiobooks" },
            ]}
          />
          <p className="text-xs text-[#6a6f78]">
            Supported formats: MP3, M4A, FLAC, WAV, AIFF, OGG, Opus
          </p>
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
        folders={
          foldersToScan ??
          folders.map((f) => ({
            name: f.name,
            path: f.path,
            contentType: f.contentType,
          }))
        }
      />

      {/* Create Shadow Library Modal */}
      <Modal
        open={showCreateShadow}
        onClose={() => setShowCreateShadow(false)}
        title="Create Shadow Library"
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={shadowName}
            onChange={(e) => setShadowName(e.target.value)}
            placeholder="MP3 320k for iPod"
          />
          <div>
            <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
              Path
            </label>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] placeholder:text-[#5a5f68] outline-none focus:border-[#4a9eff]/50 transition-colors"
                value={shadowPath}
                onChange={(e) => setShadowPath(e.target.value)}
                placeholder="/path/to/shadow/library"
              />
              <Button size="md" onClick={handlePickShadowPath}>
                Browse
              </Button>
            </div>
          </div>
          <Select
            label="Codec Configuration"
            options={[
              { value: "", label: "Select a codec…" },
              ...transcodableCodecConfigs.map((cc) => ({
                value: String(cc.id),
                label: formatShadowCodecLabel(cc),
              })),
            ]}
            value={shadowCodecConfigId != null ? String(shadowCodecConfigId) : ""}
            onChange={(v) => setShadowCodecConfigId(v ? Number(v) : null)}
            placeholder="Select a codec…"
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setShowCreateShadow(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreateShadow}
              disabled={!shadowName || !shadowPath || shadowCodecConfigId == null}
            >
              Create & Build
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete Shadow Library confirmation */}
      <Modal
        open={shadowDeleteModal !== null}
        onClose={() => setShadowDeleteModal(null)}
        title="Delete shadow library?"
        className="max-w-sm"
      >
        <div className="flex flex-col gap-5">
          <p className="text-sm text-[#8a8f98] leading-relaxed">
            Remove{" "}
            <span className="font-medium text-[#e0e0e0]">
              {shadowDeleteModal?.name ?? ""}
            </span>{" "}
            from the app. You can keep the converted files on disk or delete them.
          </p>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-[#8a8f98]">
            <input
              type="checkbox"
              checked={keepFilesWhenDelete}
              onChange={(e) => setKeepFilesWhenDelete(e.target.checked)}
              className="rounded border-white/20 bg-white/5 text-[#4a9eff] focus:ring-[#4a9eff]/50"
            />
            Keep files on disk
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShadowDeleteModal(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                confirmDeleteShadow();
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      <MpcUnavailableModal
        open={showMpcModal}
        onClose={() => setShowMpcModal(false)}
        onDontRemind={async () => {
          await setMpcRemindDisabled(true).catch(console.error);
          setMpcRemindDisabledState(true);
        }}
      />

      {/* Shadow Build Progress Modal: − minimizes (build continues in background), listener stays active */}
      <Modal
        open={showShadowBuild}
        closeIcon="−"
        onClose={() => {
          setShowShadowBuild(false);
          if (
            shadowBuildProgress?.status !== "building"
          ) {
            shadowBuildUnsubRef.current?.();
            shadowBuildUnsubRef.current = null;
          }
        }}
        title="Building Shadow Library"
        className="max-w-xl"
      >
        <div className="flex flex-col gap-4">
          <ProgressBar
            value={
              shadowBuildProgress && shadowBuildProgress.total > 0
                ? Math.round(
                    (shadowBuildProgress.processed / shadowBuildProgress.total) *
                      100
                  )
                : 0
            }
            showPercent
            variant={
              shadowBuildProgress?.status === "complete"
                ? "success"
                : shadowBuildProgress?.status === "error"
                ? "error"
                : "default"
            }
          />
          <div className="flex items-center justify-between text-xs text-[#8a8f98]">
            <span className="truncate max-w-[60%]">
              {shadowBuildProgress?.status === "error"
                ? "Build failed"
                : shadowBuildProgress?.currentFile
                  ? `Converting: ${shadowBuildProgress.currentFile}`
                  : "Preparing…"}
            </span>
            <span className="tabular-nums shrink-0">
              {shadowBuildProgress
                ? `${shadowBuildProgress.processed}/${shadowBuildProgress.total}`
                : "—"}
            </span>
          </div>

          {/* Scrolling log */}
          <div
            ref={shadowLogRef}
            className="h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-3 text-xs font-mono"
          >
            {shadowBuildLogs.length === 0 && (
              <p className="text-[#5a5f68]">Waiting for files…</p>
            )}
            {shadowBuildLogs.map((entry, i) => {
              const color =
                entry.level === "success" ? "text-[#22c55e]"
                : entry.level === "error" ? "text-[#ef4444]"
                : entry.level === "skip" ? "text-[#f5bf42]"
                : "text-[#8a8f98]";
              const icon =
                entry.level === "success" ? "▶"
                : entry.level === "error" ? "✕"
                : entry.level === "skip" ? "◐"
                : "…";
              return (
                <div key={i} className={`flex items-start gap-2 py-0.5 ${color}`}>
                  <span className="shrink-0 w-4 flex justify-center">{icon}</span>
                  <span className="truncate text-[#8a8f98]">{entry.message}</span>
                </div>
              );
            })}
          </div>

          {shadowBuildProgress?.status === "complete" && (
            <p className="text-center text-sm text-[#22c55e]">
              Build complete — {shadowBuildProgress.processed} tracks processed
            </p>
          )}
          {shadowBuildProgress?.status === "cancelled" && (
            <p className="text-center text-sm text-[#f5bf42]">Build cancelled</p>
          )}
          {shadowBuildProgress?.status === "error" && (
            <p className="text-center text-sm text-[#ef4444]">Build failed</p>
          )}
          <div className="flex justify-between items-center pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const text = shadowBuildLogs
                  .map((e) => `[${(e.level ?? "info").toUpperCase()}] ${e.message}`)
                  .join("\n");
                navigator.clipboard.writeText(text).catch(console.error);
              }}
              disabled={shadowBuildLogs.length === 0}
            >
              Copy Logs
            </Button>
            <div className="flex gap-2">
              {shadowBuildProgress?.status === "building" ? (
                <Button variant="danger" size="sm" onClick={handleCancelShadowBuild}>
                  Cancel Build
                </Button>
              ) : (
                <Button onClick={() => setShowShadowBuild(false)}>Close</Button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
