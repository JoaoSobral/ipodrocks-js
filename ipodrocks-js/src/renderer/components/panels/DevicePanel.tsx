import { useEffect, useState, useMemo, useRef, useCallback } from "react";

import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { InfoTooltip } from "../common/InfoTooltip";
import { Label } from "../common/Label";
import { Modal } from "../common/Modal";
import { ProgressBar } from "../common/ProgressBar";
import { Select } from "../common/Select";
import { Spinner } from "../common/Spinner";
import { EmptyState } from "../common/EmptyState";
import { useDeviceStore } from "../../stores/device-store";
import {
  addDevice,
  updateDevice,
  removeDevice,
  checkDevice,
  pingDevice,
  pickFolder,
  getDeviceModels,
  getCodecConfigs,
  setDefaultDevice,
  getDefaultDeviceId,
  getShadowLibraries,
  isMpcencAvailable,
  getMpcRemindDisabled,
  setMpcRemindDisabled,
} from "../../ipc/api";
import { MpcUnavailableModal } from "../modals/MpcUnavailableModal";
import { formatCodecLabel } from "../../utils/format";
import { getTranscodableCodecConfigs } from "../../utils/codec";
import type { CheckResult, DeviceModel, CodecConfig } from "../../ipc/api";
import type { DeviceProfile, ShadowLibrary } from "@shared/types";

function downloadOrphansCsv(cr: CheckResult): void {
  const rows: string[][] = [["type", "device_path"]];
  for (const p of cr.orphansMusicPaths ?? []) {
    rows.push(["music", p]);
  }
  for (const p of cr.orphansPodcastPaths ?? []) {
    rows.push(["podcast", p]);
  }
  for (const p of cr.orphansAudiobookPaths ?? []) {
    rows.push(["audiobook", p]);
  }
  for (const p of cr.orphansPlaylistPaths ?? []) {
    rows.push(["playlist", p]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `orphans-${cr.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const checkboxClass =
  "h-4 w-4 rounded border-border bg-input accent-primary cursor-pointer";

export function DevicePanel() {
  const devices = useDeviceStore((s) => s.devices);
  const loading = useDeviceStore((s) => s.loading);
  const fetchDevices = useDeviceStore((s) => s.fetchDevices);
  const deviceList = Array.isArray(devices) ? devices : [];
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [checkResults, setCheckResults] = useState<Record<number, CheckResult>>({});
  const [checking, setChecking] = useState<Set<number>>(new Set());
  const [onlineStatus, setOnlineStatus] = useState<Record<number, boolean | null>>({});

  // Form state
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [mountPath, setMountPath] = useState("");
  const [defaultCodecConfigId, setDefaultCodecConfigId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [playbackLogEnabled, setPlaybackLogEnabled] = useState(true);
  const [rockboxSmartPlaylists, setRockboxSmartPlaylists] = useState(false);
  const [musicFolder, setMusicFolder] = useState("Music");
  const [podcastFolder, setPodcastFolder] = useState("Podcasts");
  const [audiobookFolder, setAudiobookFolder] = useState("Audiobooks");
  const [playlistFolder, setPlaylistFolder] = useState("Playlists");
  const [transferMode, setTransferMode] = useState<"direct" | "transcode">("direct");
  const [sourceLibraryType, setSourceLibraryType] = useState<"primary" | "shadow">("primary");
  const [shadowLibraryId, setShadowLibraryId] = useState<number | null>(null);

  // Lookup data
  const [models, setModels] = useState<DeviceModel[]>([]);
  const [codecConfigs, setCodecConfigs] = useState<CodecConfig[]>([]);
  const [defaultDeviceId, setDefaultDeviceId] = useState<number | null>(null);
  const [shadowLibs, setShadowLibs] = useState<ShadowLibrary[]>([]);
  const [mpcAvailable, setMpcAvailable] = useState(true);
  const [mpcRemindDisabled, setMpcRemindDisabledState] = useState(false);
  const [showMpcModal, setShowMpcModal] = useState(false);
  const mpcModalShownRef = useRef(false);

  useEffect(() => {
    fetchDevices();
    getDeviceModels().then(setModels).catch(console.error);
    getCodecConfigs().then(setCodecConfigs).catch(console.error);
    getDefaultDeviceId().then(setDefaultDeviceId).catch(console.error);
    getShadowLibraries().then(setShadowLibs).catch(console.error);
    isMpcencAvailable().then((r) => setMpcAvailable(r.available)).catch(() => setMpcAvailable(false));
    getMpcRemindDisabled().then((r) => setMpcRemindDisabledState(r.disabled)).catch(console.error);
  }, [fetchDevices]);

  useEffect(() => {
    const list = Array.isArray(devices) ? devices : [];
    if (list.length === 0) return;
    for (const d of list) {
      if (d?.id == null) continue;
      pingDevice(d.id)
        .then((r) => setOnlineStatus((prev) => ({ ...prev, [d.id]: r.online })))
        .catch(() => setOnlineStatus((prev) => ({ ...prev, [d.id]: false })));
    }
  }, [devices]);

  useEffect(() => {
    if (mpcModalShownRef.current) return;
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const hasMpc = configs.some((c) => (c?.codec_name ?? "").toUpperCase() === "MPC");
    if (hasMpc && !mpcAvailable && !mpcRemindDisabled) {
      mpcModalShownRef.current = true;
      setShowMpcModal(true);
    }
  }, [codecConfigs, mpcAvailable, mpcRemindDisabled]);

  const resetForm = useCallback(() => {
    setName("");
    setModelId(null);
    setMountPath("");
    setDefaultCodecConfigId(null);
    setDescription("");
    setIsDefault(false);
    setPlaybackLogEnabled(true); // true = read playback.log (default)
    setRockboxSmartPlaylists(false);
    setMusicFolder("Music");
    setPodcastFolder("Podcasts");
    setAudiobookFolder("Audiobooks");
    setPlaylistFolder("Playlists");
    setEditingDeviceId(null);
    setTransferMode("direct");
    setSourceLibraryType("primary");
    setShadowLibraryId(null);
  }, []);

  const openForEdit = useCallback(
    (device: DeviceProfile) => {
    setEditingDeviceId(device.id);
    setName(device.name);
    setModelId(device.modelId ?? null);
    setMountPath(device.mountPath);
    setDescription(device.description ?? "");
    setIsDefault(defaultDeviceId === device.id);
    setMusicFolder(device.musicFolder ?? "Music");
    setPodcastFolder(device.podcastFolder ?? "Podcasts");
    setAudiobookFolder(device.audiobookFolder ?? "Audiobooks");
    setPlaylistFolder(device.playlistFolder ?? "Playlists");

    const isDirectCopy =
      !device.codecName ||
      ["DIRECT COPY", "COPY", "NONE"].includes(
        (device.codecName ?? "").toUpperCase()
      );

    if (isDirectCopy) {
      setTransferMode("direct");
      setDefaultCodecConfigId(device.defaultCodecConfigId ?? null);
      setSourceLibraryType(device.sourceLibraryType ?? "primary");
      setShadowLibraryId(device.shadowLibraryId ?? null);
    } else {
      setTransferMode("transcode");
      setDefaultCodecConfigId(device.defaultCodecConfigId ?? null);
      setSourceLibraryType("primary");
      setShadowLibraryId(null);
    }

    setPlaybackLogEnabled(!(device.skipPlaybackLog ?? false));
    setRockboxSmartPlaylists(device.rockboxSmartPlaylists ?? false);

    setShowDeviceModal(true);
  },
    [defaultDeviceId]
  );

  const openForAdd = useCallback(() => {
    resetForm();
    setShowDeviceModal(true);
  }, [resetForm]);

  const directCopyConfigId = useMemo(() => {
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const dc = configs.find(
      (cc) => (cc?.codec_name ?? "").toUpperCase() === "DIRECT COPY"
    );
    return dc?.id ?? null;
  }, [codecConfigs]);

  async function handleSaveDevice() {
    if (!name.trim() || !mountPath.trim() || modelId == null) return;

    let resolvedCodecConfigId = defaultCodecConfigId;
    let resolvedSourceType: "primary" | "shadow" = sourceLibraryType;
    let resolvedShadowId: number | null = shadowLibraryId;

    if (transferMode === "direct") {
      resolvedCodecConfigId = directCopyConfigId;
      if (sourceLibraryType !== "shadow") {
        resolvedShadowId = null;
        resolvedSourceType = "primary";
      }
    } else {
      resolvedSourceType = "primary";
      resolvedShadowId = null;
    }

    const payload = {
      name,
      mountPath,
      modelId,
      defaultCodecConfigId: resolvedCodecConfigId,
      description: description || null,
      musicFolder,
      podcastFolder,
      audiobookFolder,
      playlistFolder,
      sourceLibraryType: resolvedSourceType,
      shadowLibraryId: resolvedShadowId,
      skipPlaybackLog: !playbackLogEnabled,
      rockboxSmartPlaylists,
    };

    if (editingDeviceId !== null) {
      const result = await updateDevice(editingDeviceId, payload);
      if ("error" in result) return;
      if (isDefault) {
        await setDefaultDevice(editingDeviceId);
        setDefaultDeviceId(editingDeviceId);
      }
    } else {
      const device = await addDevice(payload);
      if (isDefault && device?.id) {
        await setDefaultDevice(device.id);
        setDefaultDeviceId(device.id);
      }
    }
    setShowDeviceModal(false);
    resetForm();
    fetchDevices();
  }

  async function handleRemove(id: number) {
    await removeDevice(id);
    if (defaultDeviceId === id) setDefaultDeviceId(null);
    fetchDevices();
  }

  async function handleCheck(id: number) {
    setChecking((prev) => new Set(prev).add(id));
    try {
      const result = await checkDevice(id);
      setCheckResults((prev) => ({ ...prev, [id]: result }));
      setOnlineStatus((prev) => ({ ...prev, [id]: !result.offline }));
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const transcodableConfigs = useMemo(
    () =>
      getTranscodableCodecConfigs(codecConfigs, mpcAvailable).sort(
        (a, b) =>
          (a?.codec_name ?? "").localeCompare(b?.codec_name ?? "") ||
          (a?.name ?? "").localeCompare(b?.name ?? "")
      ),
    [codecConfigs, mpcAvailable]
  );

  async function handlePickMount() {
    const result = await pickFolder();
    if (result) setMountPath(result);
  }

  function formatGb(gb: number): string {
    return `${gb.toFixed(1)} GB`;
  }

  return (
    <div className="panel-content flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={openForAdd}>
          + Add Device
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          {deviceList.length} device{deviceList.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Device grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size="md" />
        </div>
      ) : deviceList.length === 0 ? (
        <EmptyState
          icon="⊞"
          title="No devices configured"
          description="Add a device to manage your iPod or music player"
          action={
            <Button variant="primary" size="sm" onClick={openForAdd}>
              + Add Device
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {deviceList.map((d, idx) => {
            const cr = checkResults[d?.id];
            const isDefaultDev = defaultDeviceId === d?.id;
            const status = d?.id != null ? onlineStatus[d.id] : null;
            return (
              <Card key={d?.id ?? `device-${idx}`}>
                <div className="flex items-start gap-3 mb-4">
                  <div className="relative w-10 h-10 rounded-xl bg-success/10 flex items-center justify-center text-lg text-success flex-shrink-0">
                    ⊞
                    {status !== null && status !== undefined && (
                      <span
                        className={`absolute top-0 left-0 w-2.5 h-2.5 rounded-full border-2 border-card ${
                          status ? "bg-green-500" : "bg-red-500"
                        }`}
                        title={status ? "Device connected" : "Device not connected"}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-white">{d?.name ?? "Unknown"}</h4>
                      {isDefaultDev && (
                        <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-primary/15 text-primary">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground truncate">{d?.mountPath ?? ""}</p>
                  </div>
                </div>

                <div className="space-y-2 text-xs mb-4">
                  {d.modelName && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Model</span>
                      <span className="text-muted-foreground">{d.modelName}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Transfer</span>
                    <span className="text-muted-foreground">
                      {d?.sourceLibraryType === "shadow"
                        ? `Direct Copy (Shadow #${d?.shadowLibraryId ?? "?"})`
                        : d?.codecName &&
                          !["DIRECT COPY", "COPY", "NONE"].includes(
                            (d.codecName ?? "").toUpperCase()
                          )
                        ? `Transcode: ${d?.codecConfigName ?? d?.codecName ?? ""}`
                        : "Direct Copy (Primary)"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last sync date</span>
                    <span className="text-muted-foreground">
                      {d?.lastSyncDate
                        ? new Date(d.lastSyncDate).toLocaleDateString()
                        : "Never"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total on device</span>
                    <span className="text-muted-foreground">{(d?.totalSyncedItems ?? 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Items in last sync</span>
                    <span className="text-muted-foreground">{(d?.lastSyncCount ?? 0).toLocaleString()}</span>
                  </div>
                </div>

                {cr?.offline && (
                  <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                    <p className="text-xs text-destructive font-medium">Device not connected</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Mount path is unavailable. Reconnect the device and try again.
                    </p>
                  </div>
                )}

                {cr && !cr.offline && (
                  <div className="mb-4 p-3 rounded-lg bg-muted/30 space-y-2">
                    {cr.disk != null && (
                      <>
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Storage</span>
                          <span className="text-muted-foreground">
                            {formatGb((cr.disk.totalGb ?? 0) - (cr.disk.freeGb ?? 0))} / {formatGb(cr.disk.totalGb ?? 0)}
                          </span>
                        </div>
                        <ProgressBar
                          value={(cr.disk.totalGb ?? 0) > 0 ? (((cr.disk.totalGb ?? 0) - (cr.disk.freeGb ?? 0)) / (cr.disk.totalGb ?? 1)) * 100 : 0}
                          color={(cr.disk.freeGb ?? 0) < 1 ? "var(--destructive)" : undefined}
                        />
                      </>
                    )}
                    {cr.music != null && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Music</span>
                        <span className="text-muted-foreground">
                          {cr.music.fileCount ?? 0} files · {formatGb(cr.music.totalGb ?? 0)}
                        </span>
                      </div>
                    )}
                    {typeof cr.musicSyncedWithLibrary === "number" && (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Music vs Library</span>
                          <span className="text-muted-foreground">
                            {[
                              `${cr.musicSyncedWithLibrary} synced`,
                              (cr.musicCodecMismatch ?? 0) > 0 &&
                                `${cr.musicCodecMismatch} codec mismatch`,
                              (cr.musicToSync ?? 0) > 0 && `${cr.musicToSync} to sync`,
                              (cr.musicOrphans ?? 0) > 0 && `${cr.musicOrphans} orphans`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        {(cr.musicCodecMismatch ?? 0) > 0 && cr.profileCodecName && (
                          <p className="text-[10px] text-muted-foreground">
                            Codec mismatch files will be re-encoded to{" "}
                            {cr.profileCodecName} on next sync.
                          </p>
                        )}
                      </div>
                    )}
                    {typeof cr.podcastSyncedWithLibrary === "number" && (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Podcasts vs Library</span>
                          <span className="text-muted-foreground">
                            {[
                              `${cr.podcastSyncedWithLibrary} synced`,
                              (cr.podcastCodecMismatch ?? 0) > 0 &&
                                `${cr.podcastCodecMismatch} codec mismatch`,
                              (cr.podcastToSync ?? 0) > 0 && `${cr.podcastToSync} to sync`,
                              (cr.podcastOrphans ?? 0) > 0 && `${cr.podcastOrphans} orphans`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        {(cr.podcastCodecMismatch ?? 0) > 0 && cr.profileCodecName && (
                          <p className="text-[10px] text-muted-foreground">
                            Codec mismatch files will be re-encoded to{" "}
                            {cr.profileCodecName} on next sync.
                          </p>
                        )}
                      </div>
                    )}
                    {typeof cr.audiobookSyncedWithLibrary === "number" && (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Audiobooks vs Library</span>
                          <span className="text-muted-foreground">
                            {[
                              `${cr.audiobookSyncedWithLibrary} synced`,
                              (cr.audiobookCodecMismatch ?? 0) > 0 &&
                                `${cr.audiobookCodecMismatch} codec mismatch`,
                              (cr.audiobookToSync ?? 0) > 0 && `${cr.audiobookToSync} to sync`,
                              (cr.audiobookOrphans ?? 0) > 0 && `${cr.audiobookOrphans} orphans`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </div>
                        {(cr.audiobookCodecMismatch ?? 0) > 0 && cr.profileCodecName && (
                          <p className="text-[10px] text-muted-foreground">
                            Codec mismatch files will be re-encoded to{" "}
                            {cr.profileCodecName} on next sync.
                          </p>
                        )}
                      </div>
                    )}
                    {cr.playlists != null && (
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Playlists</span>
                        <span className="text-muted-foreground">
                          {cr.playlists.fileCount ?? 0} file{(cr.playlists.fileCount ?? 0) !== 1 ? "s" : ""}
                          {(cr.playlists.totalGb ?? 0) > 0 ? ` · ${formatGb(cr.playlists.totalGb ?? 0)}` : ""}
                          {(cr.playlistOrphans ?? 0) > 0 ? ` · ${cr.playlistOrphans} orphans` : ""}
                        </span>
                      </div>
                    )}
                    {((cr.orphansMusicPaths?.length ?? 0) +
                      (cr.orphansPodcastPaths?.length ?? 0) +
                      (cr.orphansAudiobookPaths?.length ?? 0) +
                      (cr.orphansPlaylistPaths?.length ?? 0)) > 0 && (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full mt-2"
                        onClick={() => downloadOrphansCsv(cr)}
                      >
                        Download orphans CSV
                      </Button>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => d?.id != null && handleCheck(d.id)}
                    disabled={checking.has(d?.id ?? 0)}
                  >
                    {checking.has(d?.id ?? 0) ? "Checking…" : "Check Device"}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => d && openForEdit(d)}>
                    Edit
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => d?.id != null && handleRemove(d.id)}
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit Device Modal */}
      <Modal
        open={showDeviceModal}
        onClose={() => {
          setShowDeviceModal(false);
          resetForm();
        }}
        title={editingDeviceId !== null ? "Edit Device" : "Add Device"}
      >
        <div className="space-y-4">
          {/* Device Name */}
          <Input
            label="Device Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My iPod"
          />

          {/* Device Model */}
          <Select
            label="Device Model *"
            options={[
              { value: "", label: "Select a model…" },
              ...(Array.isArray(models) ? models : []).map((m) => ({
                value: String(m?.id ?? ""),
                label: m?.name ?? "",
              })),
            ]}
            value={modelId != null ? String(modelId) : ""}
            onChange={(v) => setModelId(v ? Number(v) : null)}
            placeholder="Select a model…"
          />

          {/* Mount Path */}
          <div>
            <Label>
              <span className="inline-flex items-center gap-1">
                Mount Path
                <InfoTooltip text="The root directory of the device (e.g. /Volumes/IPOD or /mnt/ipod), not a subfolder inside it. iPodRocks writes directly into the device's Music, Podcasts, and Playlists folders from this root." />
              </span>
            </Label>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/25 transition-colors"
                value={mountPath}
                onChange={(e) => setMountPath(e.target.value)}
                placeholder="/mnt/ipod"
              />
              <Button size="md" onClick={handlePickMount}>
                Browse
              </Button>
            </div>
          </div>

          {/* Transfer Mode */}
          <div>
            <Label>Transfer Mode</Label>
            <div className="flex gap-2">
              {(["direct", "transcode"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    transferMode === mode
                      ? "bg-primary/15 border-primary/40 text-primary"
                      : "bg-input border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                  onClick={() => setTransferMode(mode)}
                >
                  {mode === "direct" ? "Direct Copy" : "Transcode"}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {transferMode === "direct"
                ? "Copy files as-is from the primary library or a shadow library"
                : "Convert files during sync using a codec profile"}
            </p>
          </div>

          {/* Direct Copy: Source Library */}
          {transferMode === "direct" && (
            <div>
              <Select
                label="Source Library"
                tooltip="Which library files are copied from. Use a Shadow Library to sync pre-converted files and skip real-time transcoding."
                options={[
                  { value: "primary", label: "Primary Library" },
                  ...(Array.isArray(shadowLibs) ? shadowLibs : [])
                    .filter((sl) => sl?.status === "ready")
                    .map((sl) => ({
                      value: `shadow:${sl?.id ?? ""}`,
                      label: `Shadow: ${sl?.name ?? ""} (${sl?.codecName ?? ""})`,
                    })),
                ]}
                value={
                  sourceLibraryType === "shadow" && shadowLibraryId != null
                    ? `shadow:${shadowLibraryId}`
                    : "primary"
                }
                onChange={(v) => {
                  if (v.startsWith("shadow:")) {
                    setSourceLibraryType("shadow");
                    setShadowLibraryId(Number(v.split(":")[1]));
                  } else {
                    setSourceLibraryType("primary");
                    setShadowLibraryId(null);
                  }
                }}
              />
            </div>
          )}

          {/* Transcode: Codec Configuration */}
          {transferMode === "transcode" && (
            <Select
              label="Codec Configuration"
              options={[
                { value: "", label: "Select a codec…" },
                ...transcodableConfigs.map((cc) => ({
                  value: String(cc.id),
                  label: formatCodecLabel(cc),
                })),
              ]}
              value={defaultCodecConfigId != null ? String(defaultCodecConfigId) : ""}
              onChange={(v) => setDefaultCodecConfigId(v ? Number(v) : null)}
              placeholder="Select a codec…"
            />
          )}

          {/* Description */}
          <Input
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description…"
          />

          {/* Folder overrides */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Music Folder"
              value={musicFolder}
              onChange={(e) => setMusicFolder(e.target.value)}
            />
            <Input
              label="Podcast Folder"
              value={podcastFolder}
              onChange={(e) => setPodcastFolder(e.target.value)}
            />
            <Input
              label="Audiobook Folder"
              value={audiobookFolder}
              onChange={(e) => setAudiobookFolder(e.target.value)}
            />
            <Input
              label="Playlist Folder"
              value={playlistFolder}
              onChange={(e) => setPlaylistFolder(e.target.value)}
            />
          </div>

          {/* Checkboxes */}
          <div className="space-y-3 pt-1">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Set as Default Device
                <InfoTooltip text="This device will be pre-selected in the Sync panel." />
              </span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={!playbackLogEnabled}
                onChange={(e) => setPlaybackLogEnabled(!e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Do not read playback.log data
                <InfoTooltip text="Rockbox records your play history in a file called playback.log. Disable this if you don't want iPodRocks to import that history for Genius playlists." />
              </span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={rockboxSmartPlaylists}
                onChange={(e) => setRockboxSmartPlaylists(e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Rockbox smart playlists (tagnavi)
                <InfoTooltip text="When enabled, smart playlists are written to .rockbox/tagnavi_custom.config as live, auto-updating tagtree views instead of frozen .m3u snapshots. Requires Rockbox firmware on the device. Other playlist kinds still write .m3u." />
              </span>
            </label>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              onClick={() => {
                setShowDeviceModal(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveDevice}
              disabled={!name.trim() || !mountPath.trim() || modelId == null}
            >
              {editingDeviceId !== null ? "Update Device" : "Add Device"}
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
    </div>
  );
}
