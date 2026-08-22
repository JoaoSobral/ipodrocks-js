import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { toast } from "sonner";

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
  listUsbDevices,
  pickFolder,
  getDeviceModels,
  getCodecConfigs,
  setDefaultDevice,
  getDefaultDeviceId,
  getShadowLibraries,
  isMpcencAvailable,
  getMpcRemindDisabled,
  setMpcRemindDisabled,
  podcastSetDeviceAutoPodcasts,
} from "../../ipc/api";
import { MpcUnavailableModal } from "../modals/MpcUnavailableModal";
import { formatCodecLabel, formatGb } from "../../utils/format";
import { getTranscodableCodecConfigs, isVbrCapableCodec } from "../../utils/codec";
import { createDeviceIconResolver } from "../../utils/device-icon";
import { DeviceIcon } from "../common/DeviceIcon";
import type { CheckResult, DeviceModel, CodecConfig } from "../../ipc/api";
import type {
  DeviceProfile,
  ShadowLibrary,
  UsbDeviceInfo,
} from "@shared/types";
import type { SelectOption } from "../common/Select";

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

/**
 * A USB identity flattened into one string so it can live in a <Select> value.
 * Empty means "no identity — match by mount path".
 */
function usbKeyOf(
  vendorId?: string | null,
  productId?: string | null,
  serial?: string | null
): string {
  if (!vendorId || !productId) return "";
  return `${vendorId}:${productId}:${serial ?? ""}`;
}

/** Split a key back into the three columns. A blank key clears the identity. */
function parseUsbKey(key: string): {
  usbVendorId: string | null;
  usbProductId: string | null;
  usbSerial: string | null;
} {
  if (!key) return { usbVendorId: null, usbProductId: null, usbSerial: null };
  const [vendorId, productId, ...rest] = key.split(":");
  return { usbVendorId: vendorId, usbProductId: productId, usbSerial: rest.join(":") };
}

/** Best-effort display name; many devices report no product string at all. */
function usbLabel(device: UsbDeviceInfo): string {
  const base = device.ipodModel || device.productName || device.vendorName || "Unknown device";
  return device.serial ? base : `${base} (no serial)`;
}

export function DevicePanel() {
  const devices = useDeviceStore((s) => s.devices);
  const loading = useDeviceStore((s) => s.loading);
  const fetchDevices = useDeviceStore((s) => s.fetchDevices);
  const deviceList = Array.isArray(devices) ? devices : [];
  const resolveDeviceIcon = useMemo(
    () => createDeviceIconResolver(deviceList.filter((d): d is NonNullable<typeof d> => d != null)),
    [deviceList],
  );
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
  const [runtimeDataEnabled, setRuntimeDataEnabled] = useState(true);
  const [rockboxSmartPlaylists, setRockboxSmartPlaylists] = useState(false);
  const [autoPodcastsEnabled, setAutoPodcastsEnabled] = useState(false);
  const [skipAlbumArtwork, setSkipAlbumArtwork] = useState(false);
  const [artworkMaxDimension, setArtworkMaxDimension] = useState(300);
  const [vbrEnabled, setVbrEnabled] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [musicFolder, setMusicFolder] = useState("Music");
  const [podcastFolder, setPodcastFolder] = useState("Podcasts");
  const [audiobookFolder, setAudiobookFolder] = useState("Audiobooks");
  const [playlistFolder, setPlaylistFolder] = useState("Playlists");
  const [transferMode, setTransferMode] = useState<"direct" | "transcode">("direct");
  const [sourceLibraryType, setSourceLibraryType] = useState<"primary" | "shadow">("primary");
  const [shadowLibraryId, setShadowLibraryId] = useState<number | null>(null);
  const [formSubmitted, setFormSubmitted] = useState(false);
  /** Selected USB identity as "vid:pid:serial". Empty means mount-path matching. */
  const [usbKey, setUsbKey] = useState("");
  /** What the device had when the modal opened, so we can detect a clear. */
  const [originalUsbKey, setOriginalUsbKey] = useState("");
  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);
  const [usbAvailable, setUsbAvailable] = useState(true);
  const [usbLoading, setUsbLoading] = useState(false);
  const [confirmClearUsb, setConfirmClearUsb] = useState(false);

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
    setRuntimeDataEnabled(true); // true = import Rockbox's runtime data (default)
    setRockboxSmartPlaylists(false);
    setAutoPodcastsEnabled(false);
    setSkipAlbumArtwork(false);
    setArtworkMaxDimension(300);
    setVbrEnabled(false);
    setDevMode(false);
    setMusicFolder("Music");
    setPodcastFolder("Podcasts");
    setAudiobookFolder("Audiobooks");
    setPlaylistFolder("Playlists");
    setEditingDeviceId(null);
    setTransferMode("direct");
    setSourceLibraryType("primary");
    setShadowLibraryId(null);
    setFormSubmitted(false);
    setUsbKey("");
    setOriginalUsbKey("");
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

    setRuntimeDataEnabled(!(device.skipRuntimeData ?? false));
    setSkipAlbumArtwork(device.skipAlbumArtwork ?? false);
    setArtworkMaxDimension(device.artworkMaxDimension ?? 300);
    setVbrEnabled(device.vbrEnabled ?? false);
    setRockboxSmartPlaylists(device.rockboxSmartPlaylists ?? false);
    setAutoPodcastsEnabled(device.autoPodcastsEnabled ?? false);
    setDevMode(device.devMode ?? false);

    const storedUsb = usbKeyOf(device.usbVendorId, device.usbProductId, device.usbSerial);
    setUsbKey(storedUsb);
    setOriginalUsbKey(storedUsb);

    setShowDeviceModal(true);
  },
    [defaultDeviceId]
  );

  const openForAdd = useCallback(() => {
    resetForm();
    setShowDeviceModal(true);
  }, [resetForm]);

  const loadUsbDevices = useCallback(async () => {
    setUsbLoading(true);
    try {
      const result = await listUsbDevices();
      if ("error" in result) {
        setUsbAvailable(false);
        setUsbDevices([]);
      } else {
        setUsbAvailable(result.available);
        setUsbDevices(result.devices);
      }
    } catch {
      setUsbAvailable(false);
      setUsbDevices([]);
    } finally {
      setUsbLoading(false);
    }
  }, []);

  // Enumerate when the form opens — the list is a point-in-time snapshot.
  useEffect(() => {
    if (showDeviceModal) void loadUsbDevices();
  }, [showDeviceModal, loadUsbDevices]);

  const usbOptions = useMemo(() => {
    const options: SelectOption[] = [
      { value: "", label: "Not set — match by mount path only" },
    ];

    const connected = Array.isArray(usbDevices) ? usbDevices : [];
    // Recognized iPods rank above storage-class: an iPod in DFU or WTF mode
    // exposes no mass-storage interface and would otherwise sort to the bottom.
    const ipods = connected.filter((d) => d.ipodModel);
    const storage = connected.filter((d) => !d.ipodModel && d.isStorage);
    const other = connected.filter((d) => !d.ipodModel && !d.isStorage);

    for (const [group, list] of [
      ["iPods", ipods],
      ["Storage devices", storage],
      ["Other USB devices", other],
    ] as const) {
      for (const device of list) {
        options.push({
          value: usbKeyOf(device.vendorId, device.productId, device.serial),
          label: usbLabel(device),
          detail: `${device.vendorId}:${device.productId}`,
          group,
        });
      }
    }

    // A device being edited while unplugged must still round-trip its identity,
    // otherwise opening and saving the form would silently wipe it.
    if (usbKey && !options.some((o) => o.value === usbKey)) {
      const { usbVendorId, usbProductId } = parseUsbKey(usbKey);
      options.push({
        value: usbKey,
        label: "Saved device — not connected",
        detail: `${usbVendorId}:${usbProductId}`,
        group: "Saved",
      });
    }
    return options;
  }, [usbDevices, usbKey]);

  /** Warn when the chosen identity cannot tell two identical units apart. */
  const usbHint = useMemo(() => {
    if (!usbAvailable) {
      return "Could not read USB devices on this system — matching will fall back to the mount path.";
    }
    if (!usbKey) return undefined;
    const { usbSerial } = parseUsbKey(usbKey);
    if (!usbSerial) {
      return "This device reports no serial number, so it is identified by model only — two identical units would still collide.";
    }
    return undefined;
  }, [usbAvailable, usbKey]);

  const directCopyConfigId = useMemo(() => {
    const configs = Array.isArray(codecConfigs) ? codecConfigs : [];
    const dc = configs.find(
      (cc) => (cc?.codec_name ?? "").toUpperCase() === "DIRECT COPY"
    );
    return dc?.id ?? null;
  }, [codecConfigs]);

  /**
   * Dropping a USB identity is the risky direction: the device falls back to
   * mount-path matching, where another drive at the same path can be mistaken
   * for it. Confirm that explicitly; a swap to a different unit only informs.
   */
  function handleSaveClicked() {
    if (originalUsbKey && !usbKey) {
      setConfirmClearUsb(true);
      return;
    }
    void handleSaveDevice();
  }

  async function handleSaveDevice() {
    if (!name.trim() || !mountPath.trim() || modelId == null) {
      setFormSubmitted(true);
      return;
    }

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
      skipRuntimeData: !runtimeDataEnabled,
      skipAlbumArtwork,
      artworkMaxDimension,
      vbrEnabled: transferMode === "transcode" ? vbrEnabled : false,
      rockboxSmartPlaylists,
      devMode,
      ...parseUsbKey(usbKey),
    };

    if (editingDeviceId !== null) {
      const result = await updateDevice(editingDeviceId, payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      await podcastSetDeviceAutoPodcasts(editingDeviceId, autoPodcastsEnabled);
      if (isDefault) {
        await setDefaultDevice(editingDeviceId);
        setDefaultDeviceId(editingDeviceId);
      }
    } else {
      const device = await addDevice(payload);
      if ("error" in device) {
        toast.error(device.error);
        return;
      }
      if (device?.id) {
        await podcastSetDeviceAutoPodcasts(device.id, autoPodcastsEnabled);
      }
      if (isDefault && device?.id) {
        await setDefaultDevice(device.id);
        setDefaultDeviceId(device.id);
      }
    }
    if (usbKey !== originalUsbKey) {
      toast.warning(
        usbKey
          ? `'${name}' is now matched by its USB device`
          : `'${name}' is now matched by mount path only`
      );
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
                  <DeviceIcon
                    src={d ? resolveDeviceIcon(d) : null}
                    alt={d?.modelName ?? "Device"}
                    size="md"
                    connected={status}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-bold text-foreground">{d?.name ?? "Unknown"}</h4>
                      {isDefaultDev && (
                        <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-primary/15 text-primary">
                          DEFAULT
                        </span>
                      )}
                      {d?.usbVendorId && d?.usbProductId && (
                        <span
                          className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-muted text-muted-foreground"
                          title={`Matched by USB device ${d.usbVendorId}:${d.usbProductId}${
                            d.usbSerial ? ` (serial ${d.usbSerial})` : " (no serial)"
                          }`}
                        >
                          USB {d.usbVendorId}:{d.usbProductId}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2 text-xs mb-4">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Device Path</span>
                    <span className="text-muted-foreground truncate max-w-[60%] text-right">{d?.mountPath ?? ""}</span>
                  </div>
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
            hint={formSubmitted && !name.trim() ? "Please enter a device name" : undefined}
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
            hint={formSubmitted && modelId == null ? "Please select a device model" : undefined}
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
            {formSubmitted && !mountPath.trim() && (
              <p className="mt-1 text-xs text-blue-500">Please enter a mount path</p>
            )}
          </div>

          {/* USB identity — optional. Pins the device to a physical USB unit so
              two players that mount at the same path stay distinguishable. */}
          <div>
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Select
                  label="USB Device (optional)"
                  tooltip="Match this device by its USB hardware instead of its mount path. Useful when two players mount at the same path. Leave unset to match by mount path only."
                  options={usbOptions}
                  value={usbKey}
                  onChange={setUsbKey}
                  placeholder="Not set — match by mount path only"
                  hint={usbHint}
                  testId="usb-device-select"
                />
              </div>
              <Button size="md" onClick={() => void loadUsbDevices()} disabled={usbLoading}>
                {usbLoading ? "Scanning…" : "Refresh"}
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
              onChange={(v) => {
                const id = v ? Number(v) : null;
                setDefaultCodecConfigId(id);
                const cc = transcodableConfigs.find((c) => c.id === id);
                if (!isVbrCapableCodec(cc?.codec_name)) setVbrEnabled(false);
              }}
              placeholder="Select a codec…"
            />
          )}

          {transferMode === "transcode" &&
            isVbrCapableCodec(
              transcodableConfigs.find((c) => c.id === defaultCodecConfigId)?.codec_name
            ) && (
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={vbrEnabled}
                  onChange={(e) => setVbrEnabled(e.target.checked)}
                />
                <span className="text-sm text-foreground flex items-center gap-1">
                  Variable bitrate (VBR)
                  <InfoTooltip text="Encode at a quality level derived from the chosen bitrate instead of a fixed bitrate. VBR usually gives better quality per file size." />
                </span>
              </label>
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
                checked={!runtimeDataEnabled}
                onChange={(e) => setRuntimeDataEnabled(!e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Do not import play history from this device
                <InfoTooltip text="With Gather Runtime Data enabled, Rockbox records how often and how long you play each track, and your ratings. Turn this off if you don't want iPodRocks importing that from this device for statistics and Genius playlists." />
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
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={autoPodcastsEnabled}
                onChange={(e) => setAutoPodcastsEnabled(e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Auto Podcasts
                <InfoTooltip text="When enabled, new podcast episodes are automatically copied to this device in the background as they are downloaded, independently of any manual sync." />
              </span>
            </label>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={skipAlbumArtwork}
                onChange={(e) => setSkipAlbumArtwork(e.target.checked)}
              />
              <span className="text-sm text-foreground flex items-center gap-1">
                Skip album artwork
                <InfoTooltip text="When enabled, no album artwork is generated for this device during sync. Useful for devices with limited storage." />
              </span>
            </label>
            {!skipAlbumArtwork && (
              <label className="flex items-center gap-2.5 pl-7">
                <span className="text-sm text-foreground flex items-center gap-1">
                  Artwork size
                  <InfoTooltip text="A single Rockbox-compatible cover.jpg is generated per album and resized to this maximum dimension. Smaller art keeps iPods responsive; larger art can slow them down. 300 px is recommended for iPods." />
                </span>
                <select
                  className="text-sm bg-input border border-border rounded px-2 py-1"
                  value={artworkMaxDimension}
                  onChange={(e) => setArtworkMaxDimension(Number(e.target.value))}
                >
                  <option value={200}>200 px</option>
                  <option value={300}>300 px (recommended)</option>
                  <option value={500}>500 px</option>
                  <option value={750}>750 px</option>
                </select>
              </label>
            )}
            <label className="flex items-center gap-2.5 cursor-pointer opacity-60">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={devMode}
                onChange={(e) => setDevMode(e.target.checked)}
              />
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                Dev mode
                <InfoTooltip text="⚠️ Dev purposes only. Bypasses the mount-point check so a plain local folder is treated as an online device. Do not use in production." />
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
              onClick={handleSaveClicked}
            >
              {editingDeviceId !== null ? "Update Device" : "Add Device"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmClearUsb}
        onClose={() => setConfirmClearUsb(false)}
        title="Remove USB identity?"
      >
        <p className="text-sm text-muted-foreground">
          <span className="text-foreground font-medium">{name || "This device"}</span> will be
          matched by its mount path only. Another drive mounted at{" "}
          <span className="font-mono text-foreground">{mountPath}</span> could be mistaken for
          it.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmClearUsb(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmClearUsb(false);
              void handleSaveDevice();
            }}
          >
            Remove
          </Button>
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
