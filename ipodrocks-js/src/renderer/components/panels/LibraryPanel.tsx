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
import { Spinner } from "../common/Spinner";
import { Label } from "../common/Label";
import { TableHeader } from "../common/TableHeader";
import { Badge } from "../common/Badge";
import { ListRow } from "../common/ListRow";
import { ScanProgressModal } from "../modals/ScanProgressModal";
import { useLibraryStore } from "../../stores/library-store";
import { useUIStore } from "../../stores/ui-store";
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
  checkSavantKeyData,
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
  const [harmonicKeyData, setHarmonicKeyData] = useState<{
    keyedCount: number;
    totalCount: number;
    coveragePct: number;
    bpmOnlyCount: number;
  } | null>(null);
  const openSettings = useUIStore((s) => s.openSettings);

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
    checkSavantKeyData().then(setHarmonicKeyData).catch(console.error);
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
    <div className="panel-content flex flex-col gap-3 h-full min-h-0 overflow-y-auto">
      {/* Top bar */}
      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => setShowAddFolder(true)}>
          + Add Folder
        </Button>
        <Button size="sm" onClick={handleScan} disabled={folders.length === 0}>
          ⟳ Scan Library
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          onClick={handleClearCache}
          title="Clear scan cache (content hashes)"
        >
          Clear scan cache
        </Button>
        {cacheCleared !== null && (
          <span className="text-xs text-success">Cleared {cacheCleared} hash entries</span>
        )}
        <span className="text-xs text-muted-foreground">
          {stats ? `${stats.totalTracks.toLocaleString()} tracks` : ""}
        </span>
      </div>

      {/* Harmonic data — slim inline alert */}
      {harmonicKeyData && harmonicKeyData.totalCount > 0 && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-muted/30 text-[11px]">
          <span className="text-primary shrink-0">♫</span>
          <span className="text-muted-foreground flex-1 min-w-0 truncate">
            <span className="font-medium text-foreground">
              {harmonicKeyData.keyedCount}/{harmonicKeyData.totalCount}
            </span>
            {" tracks have key data "}
            <span className="text-muted-foreground">
              ({harmonicKeyData.coveragePct}%)
            </span>
            {harmonicKeyData.bpmOnlyCount > 0 && (
              <span className="text-muted-foreground">
                {" · "}{harmonicKeyData.bpmOnlyCount} BPM-only
              </span>
            )}
            {harmonicKeyData.coveragePct < 100 && (
              <span className="text-muted-foreground">
                {" — Enable harmonic extraction in Settings and re-scan"}
              </span>
            )}
          </span>
          {openSettings && harmonicKeyData.coveragePct < 100 && (
            <Button variant="ghost" size="sm" onClick={openSettings}>
              Settings
            </Button>
          )}
        </div>
      )}

      {/* Folders + Shadow Libraries — compact side-by-side grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Library Folders */}
        <Card className="!p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[11px] font-semibold text-card-foreground">
              Library Folders
            </h3>
          </div>
          {folders.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No folders yet — add one above.
            </p>
          ) : (
            <div className="space-y-1">
              {folders.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/30 transition-colors group"
                >
                  <span className="text-xs text-primary shrink-0">📁</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate leading-tight">
                      {f.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate leading-tight">
                      {f.path} · {f.contentType}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="opacity-0 group-hover:opacity-100 transition-opacity !p-1"
                    onClick={() => handleRemoveFolder(f.id)}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Shadow Libraries */}
        <Card className="!p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[11px] font-semibold text-card-foreground">
              Shadow Libraries
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="!text-[10px] !py-0.5 !px-2"
              onClick={() => setShowCreateShadow(true)}
            >
              + Create
            </Button>
          </div>
          {shadowLibs.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No shadow libraries yet.
            </p>
          ) : (
            <div className="space-y-1">
              {shadowLibs.map((sl) => (
                <div
                  key={sl.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/30 transition-colors group"
                >
                  <span className="text-xs text-primary shrink-0">◈</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-medium text-foreground truncate leading-tight">
                        {sl.name} ({formatShadowCodecAndBitrate(sl)})
                      </p>
                      <Badge
                        variant={
                          sl.status === "ready"
                            ? "success"
                            : sl.status === "building"
                              ? "warning"
                              : sl.status === "error"
                                ? "destructive"
                                : "muted"
                        }
                        className="shrink-0 !text-[8px] !px-1 !py-0"
                      >
                        {sl.status === "ready"
                          ? "Synced"
                          : sl.status === "building"
                            ? "Building"
                            : sl.status.toUpperCase()}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate leading-tight">
                      {sl.path} · {sl.trackCount} tracks
                      {" · "}{formatShadowSize(sl.totalBytes)}
                    </p>
                  </div>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!p-1"
                      onClick={() => handleRebuildShadow(sl.id)}
                      title="Rebuild"
                    >
                      ⟳
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="!p-1"
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
        </Card>
      </div>

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
          <div className="flex gap-1 p-0.5 rounded-md bg-muted/30 w-fit shrink-0">
            {(["tracks", "playlists"] as const).map((view) => (
              <button
                key={view}
                type="button"
                className={`px-3 py-1 rounded text-[11px] font-medium transition-colors capitalize ${
                  libraryView === view
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-muted-foreground"
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
            className="mb-2"
          />

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <div className="flex items-center gap-2">
              <Label className="mb-0 shrink-0">Device:</Label>
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
                className="w-32"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="mb-0 shrink-0">Type:</Label>
              <Select
                options={[
                  { value: "all", label: "All" },
                  { value: "music", label: "Music" },
                  { value: "podcast", label: "Podcast" },
                  { value: "audiobook", label: "Audiobook" },
                ]}
                value={typeFilter}
                onChange={(v) => setTypeFilter(v)}
                className="w-24"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="mb-0 shrink-0">On device:</Label>
              <Select
                options={[
                  { value: "all", label: "All" },
                  { value: "synced", label: "Synced" },
                  { value: "not_synced", label: "Not synced" },
                ]}
                value={syncFilter}
                onChange={(v) => setSyncFilter(v)}
                placeholder="All"
                className="w-24"
                disabled={selectedDeviceId == null}
              />
            </div>
          </div>

          {/* Table with horizontal scroll — contained so list and scrollbar stay inside card */}
          <div className="flex-1 min-h-[100px] overflow-auto border border-border rounded-lg bg-card mt-1.5">
            <div className="min-w-[900px]">
              {/* Header */}
              <TableHeader sticky className="theme-box">
                {columns.map((col) => (
                  <button
                    key={col.field}
                    className={`${col.width} shrink-0 text-left cursor-default hover:text-muted-foreground transition-colors`}
                    style={col.minW ? { minWidth: col.minW } : undefined}
                    onClick={() => toggleSort(col.field)}
                  >
                    {col.label}
                    {sortArrow(col.field)}
                  </button>
                ))}
                <span className="w-16 shrink-0 text-right min-w-[56px]">On device</span>
                <span className="w-16 shrink-0 text-right min-w-[56px]">Size</span>
              </TableHeader>

              {/* Rows */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Spinner />
                </div>
              ) : filtered.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-8">No tracks found</p>
              ) : (
                <List
                  height={400}
                  itemCount={filtered.length}
                  itemSize={32}
                  width="100%"
                  className="scrollbar-thin"
                >
                  {({ index, style }) => {
                    const t = filtered[index];
                    return (
                      <div
                        style={style}
                        className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/30 border-b border-border transition-colors"
                      >
                        <span className="flex-[3] min-w-[120px] truncate text-foreground">{t.title}</span>
                        <span className="flex-[2] min-w-[100px] truncate text-muted-foreground">{t.artist}</span>
                        <span className="flex-[2] min-w-[100px] truncate text-muted-foreground">{t.album}</span>
                        <span className="w-24 min-w-[80px] truncate text-muted-foreground">{t.genre}</span>
                        <span className="w-16 min-w-[56px] text-muted-foreground tabular-nums">
                          {formatDuration(t.duration)}
                        </span>
                        <span className="w-14 min-w-[48px] text-muted-foreground text-xs">{t.codec}</span>
                        <span className="w-20 min-w-[64px] text-muted-foreground text-xs">
                          {formatBitrate(t.bitrate)}
                        </span>
                        <span className="w-12 min-w-[36px] text-muted-foreground text-xs">
                          {t.bitsPerSample ? `${t.bitsPerSample}-bit` : "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-muted-foreground text-xs capitalize">
                          {t.contentType || "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-right text-success">
                          {selectedDeviceId != null && syncedPaths.has(t.path) ? "✓" : "—"}
                        </span>
                        <span className="w-16 min-w-[56px] text-right text-muted-foreground text-xs tabular-nums">
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
          <TableHeader>
            <span className="flex-[3]">Name</span>
            <span className="w-24 text-right">Songs</span>
            <span className="w-28">Type</span>
          </TableHeader>
          <div className="flex-1 overflow-auto min-h-0">
            {playlistsLoading ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : playlists.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-8">No playlists</p>
            ) : (
              playlists.map((pl) => (
                <div
                  key={pl.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 border-b border-border transition-colors"
                >
                  <span className="flex-[3] truncate text-foreground font-medium">{pl.name}</span>
                  <span className="w-24 text-right text-muted-foreground tabular-nums">
                    {pl.trackCount}
                  </span>
                  <span className="w-28">
                    <Badge variant="primary" className="capitalize">
                      {pl.typeName}
                    </Badge>
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
            <Label htmlFor="folder-path">Path</Label>
            <div className="flex gap-2">
              <input
                id="folder-path"
                className="flex-1 rounded-lg bg-muted/30 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
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
          <p className="text-xs text-muted-foreground">
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
            <Label htmlFor="shadow-path">Path</Label>
            <div className="flex gap-2">
              <input
                id="shadow-path"
                className="flex-1 rounded-lg bg-muted/30 border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 transition-colors"
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
          <p className="text-sm text-muted-foreground leading-relaxed">
            Remove{" "}
            <span className="font-medium text-foreground">
              {shadowDeleteModal?.name ?? ""}
            </span>{" "}
            from the app. You can keep the converted files on disk or delete them.
          </p>
          <label className="flex items-center gap-2 cursor-pointer text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={keepFilesWhenDelete}
              onChange={(e) => setKeepFilesWhenDelete(e.target.checked)}
              className="rounded border-border bg-muted/30 accent-primary focus:ring-primary/50"
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
          <div className="flex items-center justify-between text-xs text-muted-foreground">
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
            className="h-48 overflow-y-auto rounded-lg border border-border bg-muted/30 p-3 text-xs font-mono"
          >
            {shadowBuildLogs.length === 0 && (
              <p className="text-muted-foreground">Waiting for files…</p>
            )}
            {shadowBuildLogs.map((entry, i) => {
              const color =
                entry.level === "success" ? "text-success"
                : entry.level === "error" ? "text-destructive"
                : entry.level === "skip" ? "text-warning"
                : "text-muted-foreground";
              const icon =
                entry.level === "success" ? "▶"
                : entry.level === "error" ? "✕"
                : entry.level === "skip" ? "◐"
                : "…";
              return (
                <div key={i} className={`flex items-start gap-2 py-0.5 ${color}`}>
                  <span className="shrink-0 w-4 flex justify-center">{icon}</span>
                  <span className="truncate text-muted-foreground">{entry.message}</span>
                </div>
              );
            })}
          </div>

          {shadowBuildProgress?.status === "complete" && (
            <p className="text-center text-sm text-success">
              Build complete — {shadowBuildProgress.processed} tracks processed
            </p>
          )}
          {shadowBuildProgress?.status === "cancelled" && (
            <p className="text-center text-sm text-warning">Build cancelled</p>
          )}
          {shadowBuildProgress?.status === "error" && (
            <p className="text-center text-sm text-destructive">Build failed</p>
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
