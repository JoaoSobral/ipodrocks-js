import { useEffect, useState, useCallback } from "react";

import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { InfoTooltip } from "../common/InfoTooltip";
import { Input } from "../common/Input";
import { Select } from "../common/Select";
import { Modal } from "../common/Modal";
import { BackfillProgressModal } from "../modals/BackfillProgressModal";
import { SavantInlineChat } from "../savant/SavantInlineChat";
import { EmptyState } from "../common/EmptyState";
import { Spinner } from "../common/Spinner";
import { ErrorBox } from "../common/ErrorBox";
import { Label } from "../common/Label";
import { TableHeader } from "../common/TableHeader";
import { Badge } from "../common/Badge";
import { useDeviceStore } from "../../stores/device-store";
import { useSavantStore } from "../../stores/savant-store";
import { useUIStore } from "../../stores/ui-store";
import {
  getPlaylists,
  getPlaylistTracks,
  createPlaylist,
  deletePlaylist,
  exportPlaylist,
  getGenres,
  getArtists,
  getAlbums,
  previewSmartTracks,
  analyzeDevicePlayback,
  readDevicePlaybackLog,
  getGeniusSummaryFromDb,
  getGeniusTypes,
  generateGeniusPlaylist,
  saveGeniusPlaylist,
  generateSavantPlaylist,
  checkSavantKeyData,
  getOpenRouterConfig,
  getHarmonicPrefs,
} from "../../ipc/api";
import type {
  Playlist,
  PlaylistTrack,
  GenreInfo,
  ArtistInfo,
  AlbumInfo,
  SmartPlaylistRule,
  AnalysisSummary,
  GeniusTypeOption,
  PlaylistGenerationResult,
  AnalyzeResult,
  SavantKeyData,
  GenerateSavantResult,
} from "../../ipc/api";

type Tab = "all" | "smart" | "genius" | "savant";

type GeniusStep =
  | "idle"
  | "analyzing"
  | "summary"
  | "configuring"
  | "generating"
  | "preview";

import { formatDuration } from "../../utils/format";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

// =========================================================================
// Component
// =========================================================================

export function PlaylistPanel() {
  const devices = useDeviceStore((s) => s.devices);
  const fetchDevices = useDeviceStore((s) => s.fetchDevices);
  const setSavantTabActive = useSavantStore((s) => s.setSavantTabActive);
  const openSettings = useUIStore((s) => s.openSettings);
  const deviceList = Array.isArray(devices) ? devices : [];

  // -- playlist list state ------------------------------------------------
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  /** Which playlist kind the user picked from the Create chooser. */
  const [createKind, setCreateKind] = useState<
    "smart" | "genius" | "savant" | null
  >(null);

  // -- smart create state -------------------------------------------------
  const [newName, setNewName] = useState("");
  const [trackLimit, setTrackLimit] = useState(50);
  const [trackLimitAll, setTrackLimitAll] = useState(false);
  const [genres, setGenres] = useState<GenreInfo[]>([]);
  const [artists, setArtists] = useState<ArtistInfo[]>([]);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<number>>(new Set());
  const [selectedArtistIds, setSelectedArtistIds] = useState<Set<number>>(new Set());
  const [selectedAlbumIds, setSelectedAlbumIds] = useState<Set<number>>(new Set());
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [totalPreviewCount, setTotalPreviewCount] = useState<number | null>(null);
  const [showCutConfirm, setShowCutConfirm] = useState(false);
  const [affectedArtistIds, setAffectedArtistIds] = useState<Set<number>>(new Set());
  const [affectedGenreIds, setAffectedGenreIds] = useState<Set<number>>(new Set());
  const [affectedAlbumIds, setAffectedAlbumIds] = useState<Set<number>>(new Set());
  const [genreSearch, setGenreSearch] = useState("");
  const [artistSearch, setArtistSearch] = useState("");
  const [albumSearch, setAlbumSearch] = useState("");

  // -- genius flow state --------------------------------------------------
  const [geniusStep, setGeniusStep] = useState<GeniusStep>("idle");
  const [geniusDeviceId, setGeniusDeviceId] = useState<number | null>(null);
  const [geniusSummary, setGeniusSummary] = useState<AnalysisSummary | null>(
    null
  );
  const [geniusArtists, setGeniusArtists] = useState<
    Array<{ name: string; playCount: number }>
  >([]);
  const [geniusTypes, setGeniusTypes] = useState<GeniusTypeOption[]>([]);
  const [geniusSelectedType, setGeniusSelectedType] = useState<string | null>(
    null
  );
  const [geniusMaxTracks, setGeniusMaxTracks] = useState(25);
  const [geniusMinPlays, setGeniusMinPlays] = useState(1);
  const [geniusArtistPick, setGeniusArtistPick] = useState("");
  const [geniusTargetMonth, setGeniusTargetMonth] = useState(
    () => new Date().getMonth() + 1
  );
  const [geniusTargetYear, setGeniusTargetYear] = useState(
    () => new Date().getFullYear()
  );
  const [geniusRangeStart, setGeniusRangeStart] = useState(48);
  const [geniusRangeEnd, setGeniusRangeEnd] = useState(24);
  const [geniusPreview, setGeniusPreview] =
    useState<PlaylistGenerationResult | null>(null);
  const [geniusError, setGeniusError] = useState<string | null>(null);
  const [geniusSaveName, setGeniusSaveName] = useState("");

  // -- savant flow state ---------------------------------------------------
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState<boolean | null>(null);
  const [savantKeyData, setSavantKeyData] = useState<SavantKeyData | null>(null);
  const [savantMode, setSavantMode] = useState<"quick" | "chat">("quick");
  const [savantQuickPrompt, setSavantQuickPrompt] = useState("");
  const [savantIntentFromChat, setSavantIntentFromChat] = useState<{
    mood: string;
    seedArtist?: string;
    adventureLevel: "conservative" | "mixed" | "adventurous";
    chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
  } | null>(null);
  const [savantTargetCount, setSavantTargetCount] = useState(100);
  const [savantGenerating, setSavantGenerating] = useState(false);
  const [savantResult, setSavantResult] = useState<GenerateSavantResult | null>(
    null
  );
  const [savantError, setSavantError] = useState<string | null>(null);
  const [savantResultTracks, setSavantResultTracks] = useState<
    PlaylistTrack[] | null
  >(null);
  const [showBackfillModal, setShowBackfillModal] = useState(false);

  // -- fetch playlists ----------------------------------------------------
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getPlaylists();
      setPlaylists(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    fetchDevices();
  }, [fetchAll, fetchDevices]);

  useEffect(() => {
    setSavantTabActive(createKind === "savant");
    return () => setSavantTabActive(false);
  }, [createKind, setSavantTabActive]);

  useEffect(() => {
    if (createKind !== "savant") return;
    let cancelled = false;
    (async () => {
      const [config, keyData] = await Promise.all([
        getOpenRouterConfig(),
        checkSavantKeyData(),
      ]);
      if (!cancelled) {
        setHasOpenRouterKey(!!config?.apiKey?.trim());
        setSavantKeyData(keyData);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createKind]);

  const playlistList = Array.isArray(playlists) ? playlists : [];
  const filtered =
    activeTab === "all"
      ? playlistList
      : playlistList.filter((p) =>
          (p?.typeName ?? "").toLowerCase().includes(activeTab)
        );

  // -- playlist actions ---------------------------------------------------
  async function handleSelect(id: number) {
    setSelectedId(id);
    setTracksLoading(true);
    try {
      setTracks(await getPlaylistTracks(id));
    } finally {
      setTracksLoading(false);
    }
  }

  async function handleDelete(id: number) {
    await deletePlaylist(id);
    if (selectedId === id) setSelectedId(null);
    fetchAll();
  }

  async function handleExport(id: number) {
    await exportPlaylist(id);
  }

  // -- smart create -------------------------------------------------------
  // Load all three lists when the smart modal opens.
  useEffect(() => {
    if (createKind !== "smart") return;
    let cancelled = false;
    setOptionsLoading(true);
    Promise.all([getGenres(), getArtists(), getAlbums()])
      .then(([g, a, al]) => {
        if (!cancelled) { setGenres(g); setArtists(a); setAlbums(al); }
      })
      .finally(() => { if (!cancelled) setOptionsLoading(false); });
    return () => { cancelled = true; };
  }, [createKind]);

  // Debounced live track-count preview + affected highlighting.
  useEffect(() => {
    if (createKind !== "smart") return;
    const rules: SmartPlaylistRule[] = [
      ...[...selectedGenreIds].map((id) => ({ ruleType: "genre" as const, targetId: id, targetLabel: (Array.isArray(genres) ? genres : []).find((g) => g.id === id)?.name ?? "" })),
      ...[...selectedArtistIds].map((id) => ({ ruleType: "artist" as const, targetId: id, targetLabel: (Array.isArray(artists) ? artists : []).find((a) => a.id === id)?.name ?? "" })),
      ...[...selectedAlbumIds].map((id) => { const al = (Array.isArray(albums) ? albums : []).find((a) => a.id === id); return { ruleType: "album" as const, targetId: id, targetLabel: al ? `${al.title} — ${al.artist}` : "" }; }),
    ];
    setShowCutConfirm(false);
    if (rules.length === 0) {
      setPreviewCount(null);
      setTotalPreviewCount(null);
      setAffectedArtistIds(new Set());
      setAffectedGenreIds(new Set());
      setAffectedAlbumIds(new Set());
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await previewSmartTracks(rules, trackLimitAll ? undefined : trackLimit);
        setPreviewCount(res.count);
        setTotalPreviewCount(res.totalCount);
        setAffectedArtistIds(new Set(res.affectedArtistIds));
        setAffectedGenreIds(new Set(res.affectedGenreIds));
        setAffectedAlbumIds(new Set(res.affectedAlbumIds));
      } catch {
        // ignore preview errors
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [selectedGenreIds, selectedArtistIds, selectedAlbumIds, trackLimit, trackLimitAll, createKind, genres, artists, albums]);

  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, val: T) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }

  function buildRules(): SmartPlaylistRule[] {
    return [
      ...[...selectedGenreIds].map((id) => ({ ruleType: "genre" as const, targetId: id, targetLabel: (Array.isArray(genres) ? genres : []).find((g) => g.id === id)?.name ?? "" })),
      ...[...selectedArtistIds].map((id) => ({ ruleType: "artist" as const, targetId: id, targetLabel: (Array.isArray(artists) ? artists : []).find((a) => a.id === id)?.name ?? "" })),
      ...[...selectedAlbumIds].map((id) => { const al = (Array.isArray(albums) ? albums : []).find((a) => a.id === id); return { ruleType: "album" as const, targetId: id, targetLabel: al ? `${al.title} — ${al.artist}` : "" }; }),
    ];
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    const rules = buildRules();
    if (rules.length === 0) return;
    const isCapped = !trackLimitAll && totalPreviewCount !== null && totalPreviewCount > trackLimit;
    if (isCapped && !showCutConfirm) {
      setShowCutConfirm(true);
      return;
    }
    setShowCutConfirm(false);
    await createPlaylist({
      name: newName,
      strategy: "multi",
      trackLimit: trackLimitAll ? undefined : trackLimit,
      rules,
    });
    setShowCreate(false);
    setNewName("");
    setTrackLimit(50);
    setTrackLimitAll(false);
    setSelectedGenreIds(new Set());
    setSelectedArtistIds(new Set());
    setSelectedAlbumIds(new Set());
    setPreviewCount(null);
    setTotalPreviewCount(null);
    setAffectedArtistIds(new Set());
    setAffectedGenreIds(new Set());
    setAffectedAlbumIds(new Set());
    setGenreSearch("");
    setArtistSearch("");
    setAlbumSearch("");
    fetchAll();
  }

  // -- genius flow --------------------------------------------------------
  async function handleLoadFromDb() {
    setGeniusStep("analyzing");
    setGeniusError(null);
    try {
      const res = await getGeniusSummaryFromDb();
      setGeniusSummary(res.summary);
      setGeniusArtists(res.artists ?? []);
      if (res.summary.matchedPlays === 0) {
        setGeniusError(
          "No playback history in database. Connect a device and click Recheck device."
        );
        setGeniusStep("idle");
        return;
      }
      const types = await getGeniusTypes();
      setGeniusTypes(types);
      setGeniusStep("summary");
    } catch (err) {
      setGeniusError(err instanceof Error ? err.message : String(err));
      setGeniusStep("idle");
    }
  }

  async function handleRecheckDevice() {
    if (geniusDeviceId == null) return;
    setGeniusStep("analyzing");
    setGeniusError(null);
    try {
      const res = await readDevicePlaybackLog(geniusDeviceId);
      if (res.offline) {
        setGeniusError("Device not connected. Reconnect the device and try again.");
        setGeniusStep("idle");
        return;
      }
      if (res.error) {
        setGeniusError(res.error);
        setGeniusStep("idle");
        return;
      }
      setGeniusSummary(res.summary);
      setGeniusArtists(
        "artists" in res && Array.isArray(res.artists) ? res.artists : []
      );
      if (res.summary.matchedPlays === 0) {
        setGeniusError(
          "No playback data found. Make sure the device has been used with Rockbox."
        );
        setGeniusStep("idle");
        return;
      }
      const types = await getGeniusTypes();
      setGeniusTypes(types);
      setGeniusStep("summary");
    } catch (err) {
      setGeniusError(err instanceof Error ? err.message : String(err));
      setGeniusStep("idle");
    }
  }

  async function handleAnalyze() {
    if (geniusDeviceId == null) return;
    setGeniusStep("analyzing");
    setGeniusError(null);
    try {
      const res: AnalyzeResult = await analyzeDevicePlayback(geniusDeviceId);
      if (res.error) {
        setGeniusError(res.error);
        setGeniusStep("idle");
        return;
      }
      setGeniusSummary(res.summary);
      setGeniusArtists(res.artists ?? []);
      if (res.summary.matchedPlays === 0) {
        setGeniusError(
          "None of the played tracks in the playback log were found in your library. " +
            "Check that your library path is configured correctly."
        );
        setGeniusStep("idle");
        return;
      }
      const types = await getGeniusTypes();
      setGeniusTypes(types);
      setGeniusStep("summary");
    } catch (err) {
      setGeniusError(
        err instanceof Error ? err.message : String(err)
      );
      setGeniusStep("idle");
    }
  }

  function handlePickType(typeKey: string) {
    setGeniusSelectedType(typeKey);
    setGeniusMaxTracks(25);
    setGeniusMinPlays(1);
    setGeniusArtistPick(geniusArtists[0]?.name ?? "");
    setGeniusTargetMonth(new Date().getMonth() + 1);
    setGeniusTargetYear(new Date().getFullYear());
    setGeniusRangeStart(48);
    setGeniusRangeEnd(24);
    setGeniusStep("configuring");
  }

  async function handleGenerate() {
    if (!geniusSelectedType) return;
    setGeniusStep("generating");
    setGeniusError(null);
    try {
      const result = await generateGeniusPlaylist(
        null,
        geniusSelectedType,
        {
          maxTracks: geniusMaxTracks,
          minPlays: geniusMinPlays,
          artist:
            geniusSelectedType === "deep_dive"
              ? geniusArtistPick
              : undefined,
          targetMonth:
            geniusSelectedType === "time_capsule"
              ? geniusTargetMonth
              : undefined,
          targetYear:
            geniusSelectedType === "time_capsule"
              ? geniusTargetYear
              : undefined,
          rangeStartMonthsAgo:
            geniusSelectedType === "golden_era"
              ? geniusRangeStart
              : undefined,
          rangeEndMonthsAgo:
            geniusSelectedType === "golden_era"
              ? geniusRangeEnd
              : undefined,
        }
      );
      if ((result as unknown as { error?: string }).error) {
        setGeniusError(
          (result as unknown as { error: string }).error
        );
        setGeniusStep("configuring");
        return;
      }
      setGeniusPreview(result);
      setGeniusSaveName(result.playlistName);
      setGeniusStep("preview");
    } catch (err) {
      setGeniusError(
        err instanceof Error ? err.message : String(err)
      );
      setGeniusStep("configuring");
    }
  }

  async function handleSaveGenius() {
    if (!geniusPreview || !geniusSelectedType) return;
    const trackIds = (Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).map((t) => t?.id);
    await saveGeniusPlaylist(
      geniusSaveName || geniusPreview.playlistName,
      geniusSelectedType,
      null,
      trackIds,
      geniusMaxTracks
    );
    setGeniusStep("idle");
    setGeniusPreview(null);
    setGeniusSummary(null);
    setGeniusSelectedType(null);
    setShowCreate(false);
    setCreateKind(null);
    fetchAll();
  }

  /** Reset genius flow to device picker (stay in genius create modal). */
  function resetGenius() {
    setGeniusStep("idle");
    setGeniusSummary(null);
    setGeniusPreview(null);
    setGeniusSelectedType(null);
    setGeniusError(null);
  }

  // -- savant flow --------------------------------------------------------
  async function handleSavantGenerate() {
    const intent =
      savantMode === "quick"
        ? {
            mood: savantQuickPrompt.trim(),
            adventureLevel: "mixed" as const,
            targetCount: savantTargetCount,
          }
        : savantIntentFromChat
          ? {
              mood: savantIntentFromChat.mood,
              seedArtist: savantIntentFromChat.seedArtist?.trim() || undefined,
              adventureLevel: savantIntentFromChat.adventureLevel,
              targetCount: savantTargetCount,
              moodDiscoveryChat:
                savantIntentFromChat.chatHistory.length > 0
                  ? savantIntentFromChat.chatHistory
                  : undefined,
            }
          : null;
    if (!intent) return;
    setSavantGenerating(true);
    setSavantError(null);
    setSavantResult(null);
    setSavantResultTracks(null);
    try {
      const result = await generateSavantPlaylist(intent);
      if ("error" in result) {
        setSavantError(result.error);
        return;
      }
      setSavantResult(result);
      const tracks = await getPlaylistTracks(result.playlistId);
      setSavantResultTracks(tracks);
      fetchAll();
    } catch (err) {
      setSavantError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavantGenerating(false);
    }
  }

  function handleSavantRegenerate() {
    setSavantResult(null);
    setSavantResultTracks(null);
    handleSavantGenerate();
  }

  function handleSavantDiscard() {
    setSavantResult(null);
    setSavantResultTracks(null);
  }

  async function handleSavantViewPlaylist(id: number) {
    closeCreateModal();
    await handleSelect(id);
  }

  const [backfillOpts, setBackfillOpts] = useState<{ percent?: number } | undefined>();

  async function handleSavantBackfill() {
    const harmonic = await getHarmonicPrefs();
    const percent = harmonic.analyzeWithEssentia
      ? harmonic.analyzePercent
      : harmonic.backfillPercent;
    setBackfillOpts({ percent: percent ?? 100 });
    setShowBackfillModal(true);
  }

  async function handleBackfillComplete() {
    setShowBackfillModal(false);
    setBackfillOpts(undefined);
    const keyData = await checkSavantKeyData();
    setSavantKeyData(keyData);
  }

  function closeCreateModal() {
    setShowCreate(false);
    setCreateKind(null);
    setGeniusError(null);
    if (createKind === "smart") {
      setSelectedGenreIds(new Set());
      setSelectedArtistIds(new Set());
      setSelectedAlbumIds(new Set());
      setPreviewCount(null);
      setTotalPreviewCount(null);
      setShowCutConfirm(false);
      setAffectedArtistIds(new Set());
      setAffectedGenreIds(new Set());
      setAffectedAlbumIds(new Set());
      setGenreSearch("");
      setArtistSearch("");
      setAlbumSearch("");
    }
    if (createKind === "genius") {
      setGeniusStep("idle");
      setGeniusSummary(null);
      setGeniusPreview(null);
      setGeniusSelectedType(null);
    }
    if (createKind === "savant") {
      setSavantMode("quick");
      setSavantQuickPrompt("");
      setSavantIntentFromChat(null);
      setSavantResult(null);
      setSavantResultTracks(null);
      setSavantError(null);
    }
  }

  const selectedPlaylist = playlists.find((p) => p.id === selectedId);

  // =====================================================================
  // Detail view
  // =====================================================================
  if (selectedId && selectedPlaylist) {
    return (
      <div className="panel-content flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => setSelectedId(null)}>
            &larr; Back
          </Button>
          <h3 className="text-lg font-semibold text-foreground">
            {selectedPlaylist.name}
          </h3>
          <Badge variant="primary">{selectedPlaylist.typeName}</Badge>
          <div className="ml-auto">
            <Button size="sm" onClick={() => handleExport(selectedId)}>
              Export M3U
            </Button>
          </div>
        </div>

        <Card>
          {tracksLoading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          ) : (Array.isArray(tracks) ? tracks : []).length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-8">
              No tracks in this playlist
            </p>
          ) : (
            <>
              <TableHeader>
                <span className="w-8 text-center">#</span>
                <span className="flex-[3]">Title</span>
                <span className="flex-[2]">Artist</span>
                <span className="flex-[2]">Album</span>
                <span className="w-16 text-right">Duration</span>
              </TableHeader>
              <div className="max-h-[60vh] overflow-auto">
                {(Array.isArray(tracks) ? tracks : []).map((t, i) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 border-b border-border transition-colors"
                  >
                    <span className="w-8 text-center text-muted-foreground text-xs tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex-[3] truncate text-foreground">
                      {t.title}
                    </span>
                    <span className="flex-[2] truncate text-muted-foreground">
                      {t.artist}
                    </span>
                    <span className="flex-[2] truncate text-muted-foreground">
                      {t.album}
                    </span>
                    <span className="w-16 text-right text-muted-foreground tabular-nums">
                      {formatDuration(t.duration)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    );
  }

  // =====================================================================
  // Genius tab inline flow
  // =====================================================================
  function renderGeniusFlow() {
    // Error banner
    const errorBanner = geniusError && (
      <ErrorBox className="px-4 py-3">{geniusError}</ErrorBox>
    );

    // -- idle: load from DB or recheck device --
    if (geniusStep === "idle") {
      return (
        <div className="flex flex-col gap-5">
          {errorBanner}
          <p className="text-sm text-muted-foreground">
            Choose a data source for playback history. This is used to build
            intelligent playlists based on your listening habits.
          </p>

          <div className="grid grid-cols-2 gap-4">
            {/* Option 1: Database */}
            <div className="flex flex-col rounded-xl border border-border bg-card p-5 gap-4">
              <div>
                <div className="text-2xl mb-2">🗄️</div>
                <h4 className="text-sm font-semibold text-foreground">
                  Load from Database
                </h4>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Use playback data already synced to your library. This is the
                  fastest option if you&apos;ve synced recently.
                </p>
              </div>
              <div className="mt-auto">
                <Button variant="primary" className="w-full" onClick={handleLoadFromDb}>
                  Load Data
                </Button>
              </div>
            </div>

            {/* Option 2: Re-read from device */}
            <div className="flex flex-col rounded-xl border border-border bg-card p-5 gap-4">
              <div>
                <div className="text-2xl mb-2">📱</div>
                <h4 className="text-sm font-semibold text-foreground">
                  Re-read from Device
                </h4>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Re-scan the playback log directly from a connected device for
                  the most up-to-date data.
                </p>
              </div>
              <div className="mt-auto space-y-3">
                <Select
                  label="Device"
                  options={[
                    { value: "", label: "Select device\u2026" },
                    ...deviceList.map((d) => ({
                      value: String(d?.id ?? ""),
                      label: d?.name ?? "",
                    })),
                  ]}
                  value={geniusDeviceId != null ? String(geniusDeviceId) : ""}
                  onChange={(v) => setGeniusDeviceId(v ? Number(v) : null)}
                />
                <Button
                  variant="primary"
                  className="w-full"
                  disabled={geniusDeviceId == null}
                  onClick={handleRecheckDevice}
                >
                  Re-read Playback Log
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // -- analyzing: spinner --
    if (geniusStep === "analyzing") {
      return (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Spinner size="md" />
            <p className="text-sm text-muted-foreground">
              Reading playback log&hellip;
            </p>
          </div>
        </Card>
      );
    }

    // -- summary + type picker --
    if (geniusStep === "summary" && geniusSummary) {
      return (
        <div className="flex flex-col gap-5">
          {errorBanner}

          {/* Summary card */}
          <Card title="Analysis Summary">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-lg font-semibold text-foreground">
                  {geniusSummary.totalPlays.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Total Plays</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-success">
                  {geniusSummary.matchedPlays.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Matched</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">
                  {geniusSummary.uniqueTracks}
                </p>
                <p className="text-xs text-muted-foreground">Unique Tracks</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-muted-foreground">
                  {geniusSummary.uniqueArtists}
                </p>
                <p className="text-xs text-muted-foreground">Artists</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Date Range</span>
                <span className="text-muted-foreground">
                  {formatDate(geniusSummary.dateRange.first)} &ndash;{" "}
                  {formatDate(geniusSummary.dateRange.last)}
                </span>
              </div>
              {geniusSummary.topArtist && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Top Artist</span>
                  <span className="text-muted-foreground">
                    {geniusSummary.topArtist.name} (
                    {geniusSummary.topArtist.playCount})
                  </span>
                </div>
              )}
              {geniusSummary.topAlbum && (
                <div className="flex justify-between col-span-2">
                  <span className="text-muted-foreground">Top Album</span>
                  <span className="text-muted-foreground">
                    {geniusSummary.topAlbum.name} &mdash;{" "}
                    {geniusSummary.topAlbum.artist} (
                    {geniusSummary.topAlbum.playCount})
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Type picker grid */}
          <div className="grid grid-cols-4 gap-3">
            {(Array.isArray(geniusTypes) ? geniusTypes : []).map((gt) => (
              <button
                key={gt.value}
                type="button"
                onClick={() => handlePickType(gt.value)}
                className="text-left p-4 rounded-xl border border-border bg-muted/30 hover:bg-primary/10 hover:border-primary/30 transition-all cursor-pointer"
              >
                <div className="text-2xl mb-2">{gt.icon}</div>
                <h4 className="text-sm font-semibold text-foreground">
                  {gt.label}
                </h4>
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                  {gt.description}
                </p>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={resetGenius}>
              &larr; Back to Device Select
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setCreateKind(null)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    // -- configuring --
    if (geniusStep === "configuring" && geniusSelectedType) {
      const typeInfo = (Array.isArray(geniusTypes) ? geniusTypes : []).find(
        (t) => t.value === geniusSelectedType
      );
      const showMinPlays =
        geniusSelectedType === "most_played" ||
        geniusSelectedType === "favorites";
      const showArtistPicker = geniusSelectedType === "deep_dive";
      const showTimeCapsule = geniusSelectedType === "time_capsule";
      const showGoldenEra = geniusSelectedType === "golden_era";

      return (
        <div className="flex flex-col gap-4">
          {errorBanner}
          <Card title={`Configure: ${typeInfo?.label ?? geniusSelectedType}`}>
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {typeInfo?.description}
              </p>

              <div>
                <Label>
                  <span className="inline-flex items-center gap-1">
                    Max Tracks: {geniusMaxTracks}
                    <InfoTooltip text="Maximum number of tracks to include in the generated playlist." />
                  </span>
                </Label>
                <input
                  type="range"
                  min={5}
                  max={300}
                  step={5}
                  value={geniusMaxTracks}
                  onChange={(e) =>
                    setGeniusMaxTracks(Number(e.target.value))
                  }
                  className="w-full accent-primary"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>5</span>
                  <span>300</span>
                </div>
              </div>

              {showMinPlays && (
                <div>
                  <Label>
                    <span className="inline-flex items-center gap-1">
                      Min Plays: {geniusMinPlays}
                      <InfoTooltip text="Only include tracks that have been played at least this many times on your device." />
                    </span>
                  </Label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={geniusMinPlays}
                    onChange={(e) =>
                      setGeniusMinPlays(Number(e.target.value))
                    }
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>1</span>
                    <span>20</span>
                  </div>
                </div>
              )}

              {showArtistPicker && (
                <Select
                  label="Artist"
                  options={[
                    { value: "", label: "Select artist\u2026" },
                    ...(Array.isArray(geniusArtists) ? geniusArtists : []).map(
                      (a) => ({
                        value: a.name,
                        label: `${a.name} (${a.playCount} plays)`,
                      })
                    ),
                  ]}
                  value={geniusArtistPick}
                  onChange={(v) => setGeniusArtistPick(v)}
                />
              )}

              {showTimeCapsule && (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Month"
                    options={[
                      { value: "1", label: "January" },
                      { value: "2", label: "February" },
                      { value: "3", label: "March" },
                      { value: "4", label: "April" },
                      { value: "5", label: "May" },
                      { value: "6", label: "June" },
                      { value: "7", label: "July" },
                      { value: "8", label: "August" },
                      { value: "9", label: "September" },
                      { value: "10", label: "October" },
                      { value: "11", label: "November" },
                      { value: "12", label: "December" },
                    ]}
                    value={String(geniusTargetMonth)}
                    onChange={(v) => setGeniusTargetMonth(Number(v) || 1)}
                  />
                  <Input
                    label="Year"
                    type="number"
                    min={1990}
                    max={new Date().getFullYear() + 1}
                    value={String(geniusTargetYear)}
                    onChange={(e) =>
                      setGeniusTargetYear(
                        Number(e.target.value) || new Date().getFullYear()
                      )
                    }
                  />
                </div>
              )}

              {showGoldenEra && (
                <div className="space-y-3">
                  <div>
                    <Label>
                      Range: {geniusRangeEnd}\u2013{geniusRangeStart} months ago
                    </Label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="range"
                        min={6}
                        max={120}
                        value={geniusRangeEnd}
                        onChange={(e) =>
                          setGeniusRangeEnd(Number(e.target.value))
                        }
                        className="flex-1 accent-primary"
                      />
                      <span className="text-xs w-8">{geniusRangeEnd}m</span>
                    </div>
                    <div className="flex gap-2 items-center mt-1">
                      <input
                        type="range"
                        min={6}
                        max={120}
                        value={geniusRangeStart}
                        onChange={(e) =>
                          setGeniusRangeStart(Number(e.target.value))
                        }
                        className="flex-1 accent-primary"
                      />
                      <span className="text-xs w-8">{geniusRangeStart}m</span>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setGeniusStep("summary")}
                >
                  &larr; Back
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleGenerate}
                >
                  Generate Preview
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }

    // -- generating: spinner --
    if (geniusStep === "generating") {
      return (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Spinner size="md" />
            <p className="text-sm text-muted-foreground">
              Generating playlist&hellip;
            </p>
          </div>
        </Card>
      );
    }

    // -- preview --
    if (geniusStep === "preview" && geniusPreview) {
      return (
        <div className="flex flex-col gap-4">
          {errorBanner}
          <Card title="Playlist Preview">
            <p className="text-xs text-muted-foreground mb-2">
              {geniusPreview?.criteria ?? ""}
            </p>
            <Input
              label="Playlist Name"
              value={geniusSaveName}
              onChange={(e) => setGeniusSaveName(e.target.value)}
            />
          </Card>

          <Card>
            {(Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-8">
                No tracks matched this criteria. Try different settings.
              </p>
            ) : (
              <>
                <TableHeader>
                  <span className="w-8 text-center">#</span>
                  <span className="flex-[3]">Title</span>
                  <span className="flex-[2]">Artist</span>
                  <span className="flex-[2]">Album</span>
                  <span className="w-16 text-right">Plays</span>
                </TableHeader>
                <div className="max-h-[50vh] overflow-auto">
                  {(Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).map((t, i) => (
                    <div
                      key={`${t.id}-${i}`}
                      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 border-b border-border transition-colors"
                    >
                      <span className="w-8 text-center text-muted-foreground text-xs tabular-nums">
                        {i + 1}
                      </span>
                      <span className="flex-[3] truncate text-foreground">
                        {t.title}
                      </span>
                      <span className="flex-[2] truncate text-muted-foreground">
                        {t.artist}
                      </span>
                      <span className="flex-[2] truncate text-muted-foreground">
                        {t.album}
                      </span>
                      <span className="w-16 text-right text-muted-foreground tabular-nums">
                        {t.playCount ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setGeniusStep("configuring")}
            >
              &larr; Back
            </Button>
            {(Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).length > 0 && (
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveGenius}
              >
                Save Playlist
              </Button>
            )}
          </div>
        </div>
      );
    }

    return null;
  }

  // =====================================================================
  // Savant tab flow
  // =====================================================================
  function renderSavantFlow() {
    if (hasOpenRouterKey === false) {
      return (
        <Card>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Savant uses AI to build playlists tailored to your mood. Add your
              OpenRouter API key in Settings to enable this feature.
            </p>
            <p className="text-xs text-muted-foreground">
              Go to Settings (gear icon) → AI Settings to configure.
            </p>
          </div>
        </Card>
      );
    }

    const keyedCount = savantKeyData?.keyedCount ?? 0;
    const totalCount = savantKeyData?.totalCount ?? 0;
    const coveragePct = savantKeyData?.coveragePct ?? 0;
    const bpmOnlyCount = savantKeyData?.bpmOnlyCount ?? 0;

    if (savantResult) {
      const tracks = savantResultTracks ?? [];
      return (
        <div className="flex flex-col gap-5">
          {savantError && (
            <ErrorBox className="px-4 py-3">{savantError}</ErrorBox>
          )}
          <Card title={savantResult.name}>
            <p className="text-xs text-muted-foreground mb-3">
              {savantResult.reasoning}
            </p>
            <p className="text-sm text-muted-foreground">
              {savantResult.trackCount} tracks
              {coveragePct >= 30
                ? ` · Harmonic sequencing applied`
                : " · Harmonic sequencing unavailable (low key coverage)"}
            </p>
          </Card>
          <Card>
            <TableHeader>
              <span className="w-8 text-center">#</span>
              <span className="flex-[3]">Title</span>
              <span className="flex-[2]">Artist</span>
              <span className="flex-[2]">Album</span>
              <span className="w-16 text-right">Duration</span>
            </TableHeader>
            <div className="max-h-[40vh] overflow-auto">
              {tracks.slice(0, 8).map((t, i) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/30 border-b border-border transition-colors"
                >
                  <span className="w-8 text-center text-muted-foreground text-xs tabular-nums">
                    {i + 1}
                  </span>
                  <span className="flex-[3] truncate text-foreground">{t.title}</span>
                  <span className="flex-[2] truncate text-muted-foreground">
                    {t.artist}
                  </span>
                  <span className="flex-[2] truncate text-muted-foreground">
                    {t.album}
                  </span>
                  <span className="w-16 text-right text-muted-foreground tabular-nums">
                    {formatDuration(t.duration)}
                  </span>
                </div>
              ))}
            </div>
            {tracks.length > 8 && (
              <p className="text-[10px] text-muted-foreground px-3 py-2">
                + {tracks.length - 8} more tracks
              </p>
            )}
          </Card>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => handleSavantViewPlaylist(savantResult.playlistId)}>
              View Playlist
            </Button>
            <Button variant="secondary" size="sm" onClick={handleSavantRegenerate}>
              Regenerate
            </Button>
            <Button variant="secondary" size="sm" onClick={handleSavantDiscard}>
              Discard
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-5">
        {savantError && (
          <ErrorBox className="px-4 py-3">{savantError}</ErrorBox>
        )}
        <div className="flex gap-5">
          <Card title="1. Backfill" className="flex-1 min-w-0">
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Savant uses AI to build a playlist tailored to your mood.
              </p>
              <p className="text-xs text-muted-foreground">
                {keyedCount} / {totalCount} tracks have key data ({coveragePct}%)
                {bpmOnlyCount > 0 && (
                  <> · {bpmOnlyCount} have BPM only</>
                )}
                .
              </p>
              {coveragePct < 100 && totalCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  Most files only have BPM tags. Enable Essentia analysis in
                  Settings and run Backfill to detect keys from audio waveforms.
                </p>
              )}
              {totalCount > 0 && (
                <>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={showBackfillModal}
                      onClick={handleSavantBackfill}
                    >
                      Backfill Key Data
                    </Button>
                    {openSettings && coveragePct < 100 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={openSettings}
                      >
                        Open Settings
                      </Button>
                    )}
                  </div>
                  <BackfillProgressModal
                    open={showBackfillModal}
                    onClose={handleBackfillComplete}
                    backfillOpts={backfillOpts}
                    onComplete={handleBackfillComplete}
                  />
                </>
              )}
            </div>
          </Card>

          <Card title="2. Max Songs" className="flex-1 min-w-0">
            <div>
              <Label>
                Track count: {savantTargetCount}
              </Label>
            <input
              type="range"
              min={10}
              max={300}
              step={5}
              value={savantTargetCount}
                onChange={(e) =>
                  setSavantTargetCount(Number(e.target.value))
                }
                className="w-full accent-primary"
              />
            </div>
          </Card>
        </div>

        <Card title="3. Talk to Savant">
          <div className="flex gap-1 p-1 rounded-lg bg-muted/30 w-fit mb-4">
            {(["quick", "chat"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSavantMode(mode)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-default capitalize ${
                  savantMode === mode
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-muted-foreground"
                }`}
              >
                {mode === "quick" ? "Quick prompt" : "Chat"}
              </button>
            ))}
          </div>
          {savantMode === "quick" ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Describe your mood and, if you want, anchor on a specific artist.
                Press Enter to generate.
              </p>
              <p className="text-[10px] text-muted-foreground">
                Example: Late night coding, something like Radiohead. Or: Chill
                Sunday morning, lean on Bon Iver.
              </p>
              <input
                type="text"
                value={savantQuickPrompt}
                onChange={(e) => setSavantQuickPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && savantQuickPrompt.trim()) {
                    e.preventDefault();
                    handleSavantGenerate();
                  }
                }}
                placeholder="e.g. Road trip energy, mix of 80s and modern indie…"
                disabled={savantGenerating}
                className="w-full rounded-lg bg-muted/30 border border-border px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
            </div>
          ) : (
            <SavantInlineChat
              onIntentReady={setSavantIntentFromChat}
              onIntentClear={() => setSavantIntentFromChat(null)}
            />
          )}
        </Card>

        <Button
          variant="primary"
          disabled={
            savantGenerating ||
            (savantMode === "quick"
              ? !savantQuickPrompt.trim()
              : !savantIntentFromChat)
          }
          onClick={handleSavantGenerate}
        >
          {savantGenerating
            ? "Consulting the AI curator…"
            : savantMode === "quick"
              ? savantQuickPrompt.trim()
                ? "Create Playlist"
                : "Type a prompt to create"
              : savantIntentFromChat
                ? "Create Playlist"
                : "Complete the chat to create"}
        </Button>
      </div>
    );
  }

  // =====================================================================
  // List view
  // =====================================================================
  return (
    <div className="panel-content flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowCreate(true)}
        >
          + Create Playlist
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted/30 w-fit">
        {(["all", "smart", "genius", "savant"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors cursor-default capitalize ${
              activeTab === tab
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-muted-foreground"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size="md" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={activeTab === "savant" ? "🎯" : "≡"}
          title={activeTab === "savant" ? "No Savant playlists" : "No playlists"}
          description={
            activeTab === "savant"
              ? "Create an AI-curated Savant playlist to get started"
              : "Create a smart, genius, or savant playlist to get started"
          }
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                if (activeTab === "savant") setCreateKind("savant");
                setShowCreate(true);
              }}
            >
              + Create Playlist
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.map((p) => (
            <Card key={p.id}>
              <div className="flex items-start gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-lg text-primary">
                  {p.typeName === "genius"
                    ? "✨"
                    : p.typeName === "savant"
                      ? "🎯"
                      : "≡"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-foreground truncate">
                      {p.name}
                    </h4>
                    <Badge variant="primary" className="shrink-0">
                      {p.typeName}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {p.trackCount} tracks &middot; Updated{" "}
                    {new Date(p.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              {p.description && (
                <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                  {p.description}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => handleSelect(p.id)}>
                  View
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleDelete(p.id)}
                >
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create Playlist Modal: choice → Smart / Genius / Savant flow */}
      <Modal
        open={showCreate}
        onClose={closeCreateModal}
        wide={createKind === "genius" || createKind === "savant" || createKind === "smart"}
        width={
          createKind === "savant"
            ? "max-w-5xl"
            : createKind === "genius"
              ? "max-w-4xl"
              : createKind === "smart"
                ? "max-w-3xl"
                : undefined
        }
        title={
          createKind === null
            ? "Create Playlist"
            : createKind === "smart"
              ? "Create Smart Playlist"
              : createKind === "genius"
                ? "Create Genius Playlist"
                : "Create Savant Playlist"
        }
      >
        <div className="space-y-4">
          {createKind === null ? (
            <>
              <p className="text-sm text-muted-foreground">
                Choose the type of playlist to create.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setCreateKind("smart");
                  }}
                  className="flex-1 p-4 rounded-xl border border-border bg-muted/30 hover:bg-primary/10 hover:border-primary/30 transition-all text-left cursor-pointer"
                >
                  <div className="text-2xl mb-2">≡</div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Smart Playlist
                  </h4>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Build a playlist by combining genres, artists, and albums.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreateKind("genius");
                    setGeniusStep("idle");
                    setGeniusError(null);
                    fetchDevices();
                  }}
                  className="flex-1 p-4 rounded-xl border border-border bg-muted/30 hover:bg-primary/10 hover:border-primary/30 transition-all text-left cursor-pointer"
                >
                  <div className="text-2xl mb-2">✨</div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Genius Playlist
                  </h4>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Analyze device playback and generate smart playlists.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setCreateKind("savant")}
                  className="flex-1 p-4 rounded-xl border border-border bg-muted/30 hover:bg-primary/10 hover:border-primary/30 transition-all text-left cursor-pointer"
                >
                  <div className="text-2xl mb-2">🎯</div>
                  <h4 className="text-sm font-semibold text-foreground">
                    Savant Playlist
                  </h4>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    AI-curated playlist tuned to your mood and key data.
                  </p>
                </button>
              </div>
              <div className="flex justify-end pt-2">
                <Button onClick={closeCreateModal}>Cancel</Button>
              </div>
            </>
          ) : createKind === "genius" ? (
            <>
              {renderGeniusFlow()}
              {geniusStep === "idle" && (
                <div className="flex justify-end pt-2">
                  <Button variant="secondary" onClick={closeCreateModal}>
                    Cancel
                  </Button>
                </div>
              )}
            </>
          ) : createKind === "savant" ? (
            renderSavantFlow()
          ) : (
            /* Single-step 3-column smart playlist builder */
            <>
              <Input
                label="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Playlist"
              />
              <div>
                <label className="flex items-center gap-2 mb-1.5 cursor-pointer text-xs font-medium text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={trackLimitAll}
                    onChange={(e) => setTrackLimitAll(e.target.checked)}
                    className="accent-primary"
                  />
                  All tracks
                </label>
                <Label>Track Limit: {trackLimitAll ? "All" : trackLimit}</Label>
                <input
                  type="range"
                  min={10}
                  max={300}
                  step={10}
                  value={trackLimit}
                  onChange={(e) => setTrackLimit(Number(e.target.value))}
                  disabled={trackLimitAll}
                  className={`w-full accent-primary ${trackLimitAll ? "opacity-50 cursor-not-allowed" : ""}`}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>10</span>
                  <span>300</span>
                </div>
              </div>

              {optionsLoading ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {/* Genres column */}
                  <div className="theme-box rounded-lg border border-border bg-card p-3 flex flex-col max-h-[300px]">
                    <div className="flex items-center justify-between mb-2 shrink-0">
                      <p className="text-xs font-medium text-muted-foreground">Genres</p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedGenreIds(new Set((Array.isArray(genres) ? genres : []).map((g) => g.id)))}
                        >All</button>
                        <span className="text-[10px] text-muted-foreground">\u00b7</span>
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedGenreIds(new Set())}
                        >Clear</button>
                        {selectedGenreIds.size > 0 && (
                          <span className="text-[10px] bg-primary/20 text-primary rounded px-1">{selectedGenreIds.size}</span>
                        )}
                      </div>
                    </div>
                    <input
                      type="text"
                      placeholder="Search\u2026"
                      value={genreSearch}
                      onChange={(e) => setGenreSearch(e.target.value)}
                      className="mb-2 shrink-0 w-full rounded border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-primary"
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto space-y-0.5">
                      {(Array.isArray(genres) ? genres : [])
                        .filter((g) => !genreSearch || g.name.toLowerCase().includes(genreSearch.toLowerCase()))
                        .map((g) => {
                          const isSelected = selectedGenreIds.has(g.id);
                          const isAffected = !isSelected && affectedGenreIds.has(g.id);
                          return (
                            <label
                              key={g.id}
                              className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-xs truncate ${isSelected ? "bg-success/20 text-success" : isAffected ? "bg-warning/20 text-warning" : "hover:bg-muted/50"}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSet(setSelectedGenreIds, g.id)}
                                className="accent-primary shrink-0"
                              />
                              <span className="truncate min-w-0">{g.name}</span>
                              <span className="text-[10px] shrink-0 opacity-60">{g.trackCount}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  {/* Artists column */}
                  <div className="theme-box rounded-lg border border-border bg-card p-3 flex flex-col max-h-[300px]">
                    <div className="flex items-center justify-between mb-2 shrink-0">
                      <p className="text-xs font-medium text-muted-foreground">Artists</p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedArtistIds(new Set((Array.isArray(artists) ? artists : []).map((a) => a.id)))}
                        >All</button>
                        <span className="text-[10px] text-muted-foreground">\u00b7</span>
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedArtistIds(new Set())}
                        >Clear</button>
                        {selectedArtistIds.size > 0 && (
                          <span className="text-[10px] bg-primary/20 text-primary rounded px-1">{selectedArtistIds.size}</span>
                        )}
                      </div>
                    </div>
                    <input
                      type="text"
                      placeholder="Search\u2026"
                      value={artistSearch}
                      onChange={(e) => setArtistSearch(e.target.value)}
                      className="mb-2 shrink-0 w-full rounded border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-primary"
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto space-y-0.5">
                      {(Array.isArray(artists) ? artists : [])
                        .filter((a) => !artistSearch || a.name.toLowerCase().includes(artistSearch.toLowerCase()))
                        .map((a) => {
                          const isSelected = selectedArtistIds.has(a.id);
                          const isAffected = !isSelected && affectedArtistIds.has(a.id);
                          return (
                            <label
                              key={a.id}
                              className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-xs truncate ${isSelected ? "bg-success/20 text-success" : isAffected ? "bg-warning/20 text-warning" : "hover:bg-muted/50"}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSet(setSelectedArtistIds, a.id)}
                                className="accent-primary shrink-0"
                              />
                              <span className="truncate min-w-0">{a.name}</span>
                              <span className="text-[10px] shrink-0 opacity-60">{a.trackCount}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  {/* Albums column */}
                  <div className="theme-box rounded-lg border border-border bg-card p-3 flex flex-col max-h-[300px]">
                    <div className="flex items-center justify-between mb-2 shrink-0">
                      <p className="text-xs font-medium text-muted-foreground">Albums</p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedAlbumIds(new Set((Array.isArray(albums) ? albums : []).map((a) => a.id)))}
                        >All</button>
                        <span className="text-[10px] text-muted-foreground">\u00b7</span>
                        <button
                          type="button"
                          className="text-[10px] text-muted-foreground hover:text-foreground"
                          onClick={() => setSelectedAlbumIds(new Set())}
                        >Clear</button>
                        {selectedAlbumIds.size > 0 && (
                          <span className="text-[10px] bg-primary/20 text-primary rounded px-1">{selectedAlbumIds.size}</span>
                        )}
                      </div>
                    </div>
                    <input
                      type="text"
                      placeholder="Search\u2026"
                      value={albumSearch}
                      onChange={(e) => setAlbumSearch(e.target.value)}
                      className="mb-2 shrink-0 w-full rounded border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-primary"
                    />
                    <div className="min-h-0 flex-1 overflow-y-auto space-y-0.5">
                      {(Array.isArray(albums) ? albums : [])
                        .filter((a) => !albumSearch || `${a.title} ${a.artist}`.toLowerCase().includes(albumSearch.toLowerCase()))
                        .map((a) => {
                          const isSelected = selectedAlbumIds.has(a.id);
                          const isAffected = !isSelected && affectedAlbumIds.has(a.id);
                          return (
                            <label
                              key={a.id}
                              className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-xs truncate ${isSelected ? "bg-success/20 text-success" : isAffected ? "bg-warning/20 text-warning" : "hover:bg-muted/50"}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSet(setSelectedAlbumIds, a.id)}
                                className="accent-primary shrink-0"
                              />
                              <span className="truncate min-w-0">{a.title} &mdash; {a.artist}</span>
                              <span className="text-[10px] shrink-0 opacity-60">{a.trackCount}</span>
                            </label>
                          );
                        })}
                    </div>
                  </div>
                </div>
              )}

              {(() => {
                const isCapped = !trackLimitAll && totalPreviewCount !== null && previewCount !== null && totalPreviewCount > trackLimit;
                return (
                  <>
                    <div className="flex items-center justify-between pt-1">
                      <p className={`text-xs ${isCapped ? "text-amber-500 dark:text-amber-400 font-medium" : "text-muted-foreground"}`}>
                        {previewCount === null
                          ? "Select genres, artists, or albums to build your playlist."
                          : previewCount === 0
                            ? "No tracks match the current selection."
                            : isCapped
                              ? `${previewCount} of ${totalPreviewCount} tracks — ${totalPreviewCount - previewCount} excluded by the ${trackLimit}-track limit`
                              : `Will include ~${previewCount} track${previewCount === 1 ? "" : "s"}`}
                      </p>
                      <div className="flex gap-2">
                        <Button onClick={closeCreateModal}>Cancel</Button>
                        <Button
                          variant="primary"
                          onClick={handleCreate}
                          disabled={
                            !newName.trim() ||
                            (selectedGenreIds.size === 0 && selectedArtistIds.size === 0 && selectedAlbumIds.size === 0)
                          }
                        >
                          {showCutConfirm ? "Confirm" : "Create"}
                        </Button>
                      </div>
                    </div>
                    {showCutConfirm && (
                      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                        Only <strong>{previewCount}</strong> of <strong>{totalPreviewCount}</strong> matching tracks will be included — <strong>{totalPreviewCount! - previewCount!}</strong> will be excluded by the {trackLimit}-track limit. Click <strong>Confirm</strong> to create anyway, or adjust the limit above.
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
