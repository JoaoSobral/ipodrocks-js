import { useEffect, useState, useMemo, useRef } from "react";

import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Modal } from "../common/Modal";
import { ProgressBar } from "../common/ProgressBar";
import { Select } from "../common/Select";
import { EmptyState } from "../common/EmptyState";
import { useDeviceStore } from "../../stores/device-store";
import {
  addDevice,
  updateDevice,
  removeDevice,
  checkDevice,
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
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `orphans-${cr.name.replace(/[^a-zA-Z0-9-_]/g, "_")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function formatCodecLabel(cc: CodecConfig): string {
  const codec = (cc?.codec_name ?? "").toUpperCase();
  if (codec === "DIRECT COPY" || codec === "COPY") {
    return `${codec} - ${cc.name}`;
  }
  let detail = "";
  if (cc.bitrate_value != null) {
    detail = `(${cc.bitrate_value}kbps)`;
  } else if (cc.quality_value != null) {
    detail = `(Q${cc.quality_value})`;
  } else if (cc.bits_per_sample != null) {
    detail = `(${cc.bits_per_sample}-bit)`;
  }
  return `${codec} - ${cc.name}${detail ? ` ${detail}` : ""}`;
}

const checkboxClass =
  "h-4 w-4 rounded border-white/20 bg-white/[0.04] accent-[#4a9eff] cursor-pointer";

export function DevicePanel() {
  const { devices, loading, fetchDevices } = useDeviceStore();
  const deviceList = Array.isArray(devices) ? devices : [];
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);
  const [checkResults, setCheckResults] = useState<Record<number, CheckResult>>({});
  const [checking, setChecking] = useState<Set<number>>(new Set());

  // Form state
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState<number | null>(null);
  const [mountPath, setMountPath] = useState("");
  const [defaultCodecConfigId, setDefaultCodecConfigId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [playbackLogEnabled, setPlaybackLogEnabled] = useState(true);
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
    if (mpcModalShownRef.current) return;
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const hasMpc = configs.some((c) => (c?.codec_name ?? "").toUpperCase() === "MPC");
    if (hasMpc && !mpcAvailable && !mpcRemindDisabled) {
      mpcModalShownRef.current = true;
      setShowMpcModal(true);
    }
  }, [codecConfigs, mpcAvailable, mpcRemindDisabled]);

  function resetForm() {
    setName("");
    setModelId(null);
    setMountPath("");
    setDefaultCodecConfigId(null);
    setDescription("");
    setIsDefault(false);
    setPlaybackLogEnabled(true);
    setMusicFolder("Music");
    setPodcastFolder("Podcasts");
    setAudiobookFolder("Audiobooks");
    setPlaylistFolder("Playlists");
    setEditingDeviceId(null);
    setTransferMode("direct");
    setSourceLibraryType("primary");
    setShadowLibraryId(null);
  }

  function openForEdit(device: DeviceProfile) {
    setEditingDeviceId(device.id);
    setName(device.name);
    setModelId(device.modelId ?? null);
    setMountPath(device.mountPath);
    setDescription(device.description ?? "");
    setIsDefault(defaultDeviceId === device.id);
    setPlaybackLogEnabled(device.playbackRockboxEnable ?? true);
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

    setShowDeviceModal(true);
  }

  function openForAdd() {
    resetForm();
    setShowDeviceModal(true);
  }

  const directCopyConfigId = useMemo(() => {
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const dc = configs.find(
      (cc) => (cc?.codec_name ?? "").toUpperCase() === "DIRECT COPY"
    );
    return dc?.id ?? null;
  }, [codecConfigs]);

  async function handleSaveDevice() {
    if (!name || !mountPath || modelId == null) return;

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
      playbackRockboxEnable: playbackLogEnabled,
      musicFolder,
      podcastFolder,
      audiobookFolder,
      playlistFolder,
      sourceLibraryType: resolvedSourceType,
      shadowLibraryId: resolvedShadowId,
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
      (Array.isArray(codecConfigs) ? codecConfigs : [])
        .filter((cc) => (cc?.codec_name ?? "").toUpperCase() !== "DIRECT COPY")
        .filter(
          (cc) =>
            mpcAvailable ||
            (cc?.codec_name ?? "").toUpperCase() !== "MPC"
        )
        .sort(
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
        <span className="text-xs text-[#5a5f68] ml-auto">
          {deviceList.length} device{deviceList.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Device grid */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
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
            return (
              <Card key={d?.id ?? `device-${idx}`}>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-[#22c55e]/10 flex items-center justify-center text-lg text-[#22c55e]">
                    ⊞
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-white">{d?.name ?? "Unknown"}</h4>
                      {isDefaultDev && (
                        <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-[#4a9eff]/15 text-[#4a9eff]">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-[#5a5f68] truncate">{d?.mountPath ?? ""}</p>
                  </div>
                </div>

                <div className="space-y-2 text-xs mb-4">
                  {d.modelName && (
                    <div className="flex justify-between">
                      <span className="text-[#5a5f68]">Model</span>
                      <span className="text-[#8a8f98]">{d.modelName}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-[#5a5f68]">Transfer</span>
                    <span className="text-[#8a8f98]">
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
                    <span className="text-[#5a5f68]">Last Sync</span>
                    <span className="text-[#8a8f98]">
                      {d?.lastSyncDate
                        ? new Date(d.lastSyncDate).toLocaleDateString()
                        : "Never"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#5a5f68]">Synced Items</span>
                    <span className="text-[#8a8f98]">{(d?.totalSyncedItems ?? 0).toLocaleString()}</span>
                  </div>
                </div>

                {cr && (
                  <div className="mb-4 p-3 rounded-lg bg-white/[0.02] space-y-2">
                    {cr.disk != null && (
                      <>
                        <div className="flex justify-between text-xs">
                          <span className="text-[#5a5f68]">Storage</span>
                          <span className="text-[#8a8f98]">
                            {formatGb((cr.disk.totalGb ?? 0) - (cr.disk.freeGb ?? 0))} / {formatGb(cr.disk.totalGb ?? 0)}
                          </span>
                        </div>
                        <ProgressBar
                          value={(cr.disk.totalGb ?? 0) > 0 ? (((cr.disk.totalGb ?? 0) - (cr.disk.freeGb ?? 0)) / (cr.disk.totalGb ?? 1)) * 100 : 0}
                          color={(cr.disk.freeGb ?? 0) < 1 ? "#ef4444" : "#4a9eff"}
                        />
                      </>
                    )}
                    {cr.music != null && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[#5a5f68]">Music</span>
                        <span className="text-[#8a8f98]">
                          {cr.music.fileCount ?? 0} files · {formatGb(cr.music.totalGb ?? 0)}
                        </span>
                      </div>
                    )}
                    {typeof cr.musicSyncedWithLibrary === "number" && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[#5a5f68]">Music vs Library</span>
                        <span className="text-[#8a8f98]">
                          {cr.musicSyncedWithLibrary} synced · {cr.musicOrphans ?? 0} orphans
                        </span>
                      </div>
                    )}
                    {typeof cr.podcastSyncedWithLibrary === "number" && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[#5a5f68]">Podcasts vs Library</span>
                        <span className="text-[#8a8f98]">
                          {cr.podcastSyncedWithLibrary} synced · {cr.podcastOrphans ?? 0} orphans
                        </span>
                      </div>
                    )}
                    {cr.playlists != null && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[#5a5f68]">Playlists</span>
                        <span className="text-[#8a8f98]">
                          {cr.playlists.fileCount ?? 0} file{(cr.playlists.fileCount ?? 0) !== 1 ? "s" : ""}
                          {(cr.playlists.totalGb ?? 0) > 0 ? ` · ${formatGb(cr.playlists.totalGb ?? 0)}` : ""}
                        </span>
                      </div>
                    )}
                    {((cr.orphansMusicPaths?.length ?? 0) + (cr.orphansPodcastPaths?.length ?? 0)) > 0 && (
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
            <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">Mount Path</label>
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-lg bg-[#131626] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] placeholder:text-[#5a5f68] outline-none focus:border-[#4a9eff]/50 transition-colors [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a] [.theme-light_&]:placeholder:text-[#9ca3af]"
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
            <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
              Transfer Mode
            </label>
            <div className="flex gap-2">
              {(["direct", "transcode"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
                    transferMode === mode
                      ? "bg-[#4a9eff]/15 border-[#4a9eff]/40 text-[#4a9eff]"
                      : "bg-white/[0.04] border-white/[0.08] text-[#8a8f98] hover:bg-white/[0.06]"
                  }`}
                  onClick={() => setTransferMode(mode)}
                >
                  {mode === "direct" ? "Direct Copy" : "Transcode"}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-[#5a5f68] mt-1">
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
              <span className="text-sm text-[#e0e0e0]">Set as Default Device</span>
            </label>

            <div>
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={playbackLogEnabled}
                  onChange={(e) => setPlaybackLogEnabled(e.target.checked)}
                />
                <span className="text-sm text-[#e0e0e0] [.theme-light_&]:text-[#1a1a1a]">
                  Enable Rockbox Playback Log
                </span>
              </label>
              <p className="text-[11px] text-[#5a5f68] mt-1 ml-[26px]">
                In Rockbox, go to Settings → Playback → Logging → yes to enable playback logs
              </p>
            </div>
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
              disabled={!name || !mountPath || modelId == null}
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
