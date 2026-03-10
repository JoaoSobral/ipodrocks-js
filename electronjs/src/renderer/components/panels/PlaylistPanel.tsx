import { useEffect, useState, useCallback } from "react";

import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Select } from "../common/Select";
import { Modal } from "../common/Modal";
import { EmptyState } from "../common/EmptyState";
import { MoodChat } from "../savant/MoodChat";
import { useDeviceStore } from "../../stores/device-store";
import {
  getPlaylists,
  getPlaylistTracks,
  createPlaylist,
  deletePlaylist,
  exportPlaylist,
  getGenres,
  getArtists,
  getAlbums,
  analyzeDevicePlayback,
  getGeniusTypes,
  generateGeniusPlaylist,
  saveGeniusPlaylist,
  generateSavantPlaylist,
  checkSavantKeyData,
  backfillSavantFeatures,
  getOpenRouterConfig,
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
  const { devices, fetchDevices } = useDeviceStore();
  const deviceList = Array.isArray(devices) ? devices : [];

  // -- playlist list state ------------------------------------------------
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  /** When true, user chose Smart from Create; when 'genius', chose Genius. */
  const [createKind, setCreateKind] = useState<"smart" | "genius" | null>(
    null
  );

  // -- smart create state -------------------------------------------------
  const [newName, setNewName] = useState("");
  const [strategy, setStrategy] = useState("by_genre");
  const [trackLimit, setTrackLimit] = useState(50);
  const [trackLimitAll, setTrackLimitAll] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [genres, setGenres] = useState<GenreInfo[]>([]);
  const [artists, setArtists] = useState<ArtistInfo[]>([]);
  const [albums, setAlbums] = useState<AlbumInfo[]>([]);
  const [selectedGenreIds, setSelectedGenreIds] = useState<Set<number>>(
    new Set()
  );
  const [selectedArtistIds, setSelectedArtistIds] = useState<Set<number>>(
    new Set()
  );
  const [selectedAlbumIds, setSelectedAlbumIds] = useState<Set<number>>(
    new Set()
  );
  const [optionsLoading, setOptionsLoading] = useState(false);

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
  const [geniusPreview, setGeniusPreview] =
    useState<PlaylistGenerationResult | null>(null);
  const [geniusError, setGeniusError] = useState<string | null>(null);
  const [geniusSaveName, setGeniusSaveName] = useState("");

  // -- savant flow state ---------------------------------------------------
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState<boolean | null>(null);
  const [savantKeyData, setSavantKeyData] = useState<SavantKeyData | null>(null);
  const [savantMood, setSavantMood] = useState("");
  const [savantMoodCustom, setSavantMoodCustom] = useState("");
  const [savantSeedArtist, setSavantSeedArtist] = useState("");
  const [savantAdventure, setSavantAdventure] = useState<
    "conservative" | "mixed" | "adventurous"
  >("mixed");
  const [savantTargetCount, setSavantTargetCount] = useState(100);
  const [savantGenerating, setSavantGenerating] = useState(false);
  const [savantResult, setSavantResult] = useState<GenerateSavantResult | null>(
    null
  );
  const [savantError, setSavantError] = useState<string | null>(null);
  const [savantResultTracks, setSavantResultTracks] = useState<
    PlaylistTrack[] | null
  >(null);
  const [savantBackfilling, setSavantBackfilling] = useState(false);
  const [savantArtists, setSavantArtists] = useState<ArtistInfo[]>([]);
  const [savantChatActive, setSavantChatActive] = useState(false);
  const [savantMoodFromChat, setSavantMoodFromChat] = useState<string | null>(
    null
  );
  const [savantChatHistory, setSavantChatHistory] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);

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
    if (activeTab !== "savant") return;
    let cancelled = false;
    (async () => {
      const [config, keyData, artistList] = await Promise.all([
        getOpenRouterConfig(),
        checkSavantKeyData(),
        getArtists(),
      ]);
      if (!cancelled) {
        setHasOpenRouterKey(!!config?.apiKey?.trim());
        setSavantKeyData(keyData);
        setSavantArtists(artistList ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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
  async function goToStep2() {
    setOptionsLoading(true);
    try {
      if (strategy === "by_genre") {
        setGenres(await getGenres());
        setSelectedArtistIds(new Set());
        setSelectedAlbumIds(new Set());
      } else if (strategy === "by_artist") {
        setArtists(await getArtists());
        setSelectedGenreIds(new Set());
        setSelectedAlbumIds(new Set());
      } else {
        setAlbums(await getAlbums());
        setSelectedGenreIds(new Set());
        setSelectedArtistIds(new Set());
      }
      setCreateStep(2);
    } finally {
      setOptionsLoading(false);
    }
  }

  function toggleSet<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, val: T) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  }

  function buildRules(): SmartPlaylistRule[] {
    if (strategy === "by_genre") {
      return (Array.isArray(genres) ? genres : [])
        .filter((g) => g != null && selectedGenreIds.has(g.id))
        .map((g) => ({
          ruleType: "genre",
          targetId: g.id,
          targetLabel: g.name ?? "",
        }));
    }
    if (strategy === "by_artist") {
      return (Array.isArray(artists) ? artists : [])
        .filter((a) => a != null && selectedArtistIds.has(a.id))
        .map((a) => ({
          ruleType: "artist",
          targetId: a.id,
          targetLabel: a.name ?? "",
        }));
    }
    return (Array.isArray(albums) ? albums : [])
      .filter((a) => a != null && selectedAlbumIds.has(a.id))
      .map((a) => ({
        ruleType: "album",
        targetId: a.id,
        targetLabel: `${a?.title ?? ""} — ${a?.artist ?? ""}`,
      }));
  }

  async function handleCreate() {
    if (!newName) return;
    const rules = buildRules();
    if (rules.length === 0) return;
    await createPlaylist({
      name: newName,
      strategy,
      trackLimit: trackLimitAll ? undefined : trackLimit,
      rules,
    });
    setShowCreate(false);
    setNewName("");
    setTrackLimit(50);
    setTrackLimitAll(false);
    setCreateStep(1);
    setSelectedGenreIds(new Set());
    setSelectedArtistIds(new Set());
    setSelectedAlbumIds(new Set());
    fetchAll();
  }

  // -- genius flow --------------------------------------------------------
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
    setGeniusStep("configuring");
  }

  async function handleGenerate() {
    if (!geniusSelectedType || geniusDeviceId == null) return;
    setGeniusStep("generating");
    setGeniusError(null);
    try {
      const result = await generateGeniusPlaylist(
        geniusDeviceId,
        geniusSelectedType,
        {
          maxTracks: geniusMaxTracks,
          minPlays: geniusMinPlays,
          artist:
            geniusSelectedType === "deep_dive"
              ? geniusArtistPick
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
    if (!geniusPreview || geniusDeviceId == null || !geniusSelectedType) return;
    const trackIds = (Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).map((t) => t?.id);
    await saveGeniusPlaylist(
      geniusSaveName || geniusPreview.playlistName,
      geniusSelectedType,
      geniusDeviceId,
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
  const MOOD_CHIPS = [
    "Deep Focus",
    "Night Drive",
    "Workout",
    "Melancholy",
    "Happy",
    "Party",
    "Chill",
    "Discover",
  ];

  async function handleSavantGenerate() {
    const mood =
      savantMoodFromChat ??
      (savantMoodCustom.trim() || savantMood || "Chill");
    setSavantGenerating(true);
    setSavantError(null);
    setSavantResult(null);
    setSavantResultTracks(null);
    try {
      const result = await generateSavantPlaylist({
        mood,
        seedArtist: savantSeedArtist.trim() || undefined,
        adventureLevel: savantAdventure,
        targetCount: savantTargetCount,
        moodDiscoveryChat:
          savantChatHistory.length > 0 ? savantChatHistory : undefined,
      });
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

  async function handleSavantBackfill() {
    setSavantBackfilling(true);
    try {
      const { processed } = await backfillSavantFeatures();
      if (processed > 0) {
        const keyData = await checkSavantKeyData();
        setSavantKeyData(keyData);
      }
    } finally {
      setSavantBackfilling(false);
    }
  }

  function closeCreateModal() {
    setShowCreate(false);
    setCreateStep(1);
    setCreateKind(null);
    setGeniusError(null);
    if (createKind === "genius") {
      setGeniusStep("idle");
      setGeniusSummary(null);
      setGeniusPreview(null);
      setGeniusSelectedType(null);
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
          <h3 className="text-lg font-semibold text-white">
            {selectedPlaylist.name}
          </h3>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#4a9eff]/10 text-[#4a9eff]">
            {selectedPlaylist.typeName}
          </span>
          <div className="ml-auto">
            <Button size="sm" onClick={() => handleExport(selectedId)}>
              Export M3U
            </Button>
          </div>
        </div>

        <Card>
          {tracksLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
            </div>
          ) : (Array.isArray(tracks) ? tracks : []).length === 0 ? (
            <p className="text-center text-xs text-[#5a5f68] py-8">
              No tracks in this playlist
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06]">
                <span className="w-8 text-center">#</span>
                <span className="flex-[3]">Title</span>
                <span className="flex-[2]">Artist</span>
                <span className="flex-[2]">Album</span>
                <span className="w-16 text-right">Duration</span>
              </div>
              <div className="max-h-[60vh] overflow-auto">
                {(Array.isArray(tracks) ? tracks : []).map((t, i) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] border-b border-white/[0.03] transition-colors"
                  >
                    <span className="w-8 text-center text-[#5a5f68] text-xs tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex-[3] truncate text-white">
                      {t.title}
                    </span>
                    <span className="flex-[2] truncate text-[#8a8f98]">
                      {t.artist}
                    </span>
                    <span className="flex-[2] truncate text-[#8a8f98]">
                      {t.album}
                    </span>
                    <span className="w-16 text-right text-[#5a5f68] tabular-nums">
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
      <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#ef4444]">
        {geniusError}
      </div>
    );

    // -- idle: device picker + analyze button --
    if (geniusStep === "idle") {
      return (
        <div className="flex flex-col gap-4">
          {errorBanner}
          <Card>
            <div className="space-y-4">
              <p className="text-sm text-[#8a8f98]">
                Analyze your device&apos;s Rockbox playback log to generate
                intelligent playlists based on your listening habits.
              </p>
              <Select
                label="Device"
                options={[
                  { value: "", label: "Select a device\u2026" },
                  ...deviceList.map((d) => ({
                    value: String(d?.id ?? ""),
                    label: d?.name ?? "",
                  })),
                ]}
                value={geniusDeviceId != null ? String(geniusDeviceId) : ""}
                onChange={(v) =>
                  setGeniusDeviceId(v ? Number(v) : null)
                }
              />
              <Button
                variant="primary"
                disabled={geniusDeviceId == null}
                onClick={handleAnalyze}
              >
                Analyze Device
              </Button>
            </div>
          </Card>
        </div>
      );
    }

    // -- analyzing: spinner --
    if (geniusStep === "analyzing") {
      return (
        <Card>
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="w-6 h-6 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
            <p className="text-sm text-[#8a8f98]">
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
                <p className="text-lg font-semibold text-white">
                  {geniusSummary.totalPlays.toLocaleString()}
                </p>
                <p className="text-xs text-[#5a5f68]">Total Plays</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[#22c55e]">
                  {geniusSummary.matchedPlays.toLocaleString()}
                </p>
                <p className="text-xs text-[#5a5f68]">Matched</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[#8a8f98]">
                  {geniusSummary.uniqueTracks}
                </p>
                <p className="text-xs text-[#5a5f68]">Unique Tracks</p>
              </div>
              <div>
                <p className="text-lg font-semibold text-[#8a8f98]">
                  {geniusSummary.uniqueArtists}
                </p>
                <p className="text-xs text-[#5a5f68]">Artists</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4 text-xs">
              <div className="flex justify-between">
                <span className="text-[#5a5f68]">Date Range</span>
                <span className="text-[#8a8f98]">
                  {formatDate(geniusSummary.dateRange.first)} &ndash;{" "}
                  {formatDate(geniusSummary.dateRange.last)}
                </span>
              </div>
              {geniusSummary.topArtist && (
                <div className="flex justify-between">
                  <span className="text-[#5a5f68]">Top Artist</span>
                  <span className="text-[#8a8f98]">
                    {geniusSummary.topArtist.name} (
                    {geniusSummary.topArtist.playCount})
                  </span>
                </div>
              )}
              {geniusSummary.topAlbum && (
                <div className="flex justify-between col-span-2">
                  <span className="text-[#5a5f68]">Top Album</span>
                  <span className="text-[#8a8f98]">
                    {geniusSummary.topAlbum.name} &mdash;{" "}
                    {geniusSummary.topAlbum.artist} (
                    {geniusSummary.topAlbum.playCount})
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Type picker grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {(Array.isArray(geniusTypes) ? geniusTypes : []).map((gt) => (
              <button
                key={gt.value}
                type="button"
                onClick={() => handlePickType(gt.value)}
                className="text-left p-4 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-[#4a9eff]/[0.06] hover:border-[#4a9eff]/30 transition-all cursor-pointer"
              >
                <div className="text-2xl mb-2">{gt.icon}</div>
                <h4 className="text-sm font-semibold text-white">
                  {gt.label}
                </h4>
                <p className="text-[11px] text-[#5a5f68] mt-1 leading-relaxed">
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

      return (
        <div className="flex flex-col gap-4">
          {errorBanner}
          <Card title={`Configure: ${typeInfo?.label ?? geniusSelectedType}`}>
            <div className="space-y-4">
              <p className="text-xs text-[#5a5f68]">
                {typeInfo?.description}
              </p>

              <div>
                <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
                  Max Tracks: {geniusMaxTracks}
                </label>
                <input
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  value={geniusMaxTracks}
                  onChange={(e) =>
                    setGeniusMaxTracks(Number(e.target.value))
                  }
                  className="w-full accent-[#4a9eff]"
                />
                <div className="flex justify-between text-[10px] text-[#5a5f68]">
                  <span>5</span>
                  <span>100</span>
                </div>
              </div>

              {showMinPlays && (
                <div>
                  <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
                    Min Plays: {geniusMinPlays}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={geniusMinPlays}
                    onChange={(e) =>
                      setGeniusMinPlays(Number(e.target.value))
                    }
                    className="w-full accent-[#4a9eff]"
                  />
                  <div className="flex justify-between text-[10px] text-[#5a5f68]">
                    <span>1</span>
                    <span>20</span>
                  </div>
                </div>
              )}

              {showArtistPicker && (
                <Select
                  label="Artist"
                  options={(Array.isArray(geniusArtists) ? geniusArtists : []).map((a) => ({
                    value: a.name,
                    label: `${a.name} (${a.playCount} plays)`,
                  }))}
                  value={geniusArtistPick}
                  onChange={(v) => setGeniusArtistPick(v)}
                />
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
            <div className="w-6 h-6 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
            <p className="text-sm text-[#8a8f98]">
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
            <p className="text-xs text-[#5a5f68] mb-2">
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
              <p className="text-center text-xs text-[#5a5f68] py-8">
                No tracks matched this criteria. Try different settings.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06]">
                  <span className="w-8 text-center">#</span>
                  <span className="flex-[3]">Title</span>
                  <span className="flex-[2]">Artist</span>
                  <span className="flex-[2]">Album</span>
                  <span className="w-16 text-right">Plays</span>
                </div>
                <div className="max-h-[50vh] overflow-auto">
                  {(Array.isArray(geniusPreview?.tracks) ? geniusPreview.tracks : []).map((t, i) => (
                    <div
                      key={`${t.id}-${i}`}
                      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] border-b border-white/[0.03] transition-colors"
                    >
                      <span className="w-8 text-center text-[#5a5f68] text-xs tabular-nums">
                        {i + 1}
                      </span>
                      <span className="flex-[3] truncate text-white">
                        {t.title}
                      </span>
                      <span className="flex-[2] truncate text-[#8a8f98]">
                        {t.artist}
                      </span>
                      <span className="flex-[2] truncate text-[#8a8f98]">
                        {t.album}
                      </span>
                      <span className="w-16 text-right text-[#5a5f68] tabular-nums">
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
            <p className="text-sm text-[#8a8f98]">
              Savant uses AI to build playlists tailored to your mood. Add your
              OpenRouter API key in Settings to enable this feature.
            </p>
            <p className="text-xs text-[#5a5f68]">
              Go to Settings (gear icon) → AI Settings to configure.
            </p>
          </div>
        </Card>
      );
    }

    const keyedCount = savantKeyData?.keyedCount ?? 0;
    const totalCount = savantKeyData?.totalCount ?? 0;
    const coveragePct = savantKeyData?.coveragePct ?? 0;

    if (savantResult) {
      const tracks = savantResultTracks ?? [];
      return (
        <div className="flex flex-col gap-5">
          {savantError && (
            <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#ef4444]">
              {savantError}
            </div>
          )}
          <Card title={savantResult.name}>
            <p className="text-xs text-[#8a8f98] mb-3">
              {savantResult.reasoning}
            </p>
            <p className="text-sm text-[#5a5f68]">
              {savantResult.trackCount} tracks
              {coveragePct >= 30
                ? ` · Harmonic sequencing applied`
                : " · Harmonic sequencing unavailable (low key coverage)"}
            </p>
          </Card>
          <Card>
            <div className="flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-[#5a5f68] uppercase tracking-wider border-b border-white/[0.06]">
              <span className="w-8 text-center">#</span>
              <span className="flex-[3]">Title</span>
              <span className="flex-[2]">Artist</span>
              <span className="flex-[2]">Album</span>
              <span className="w-16 text-right">Duration</span>
            </div>
            <div className="max-h-[40vh] overflow-auto">
              {tracks.slice(0, 8).map((t, i) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-white/[0.02] border-b border-white/[0.03] transition-colors"
                >
                  <span className="w-8 text-center text-[#5a5f68] text-xs tabular-nums">
                    {i + 1}
                  </span>
                  <span className="flex-[3] truncate text-white">{t.title}</span>
                  <span className="flex-[2] truncate text-[#8a8f98]">
                    {t.artist}
                  </span>
                  <span className="flex-[2] truncate text-[#8a8f98]">
                    {t.album}
                  </span>
                  <span className="w-16 text-right text-[#5a5f68] tabular-nums">
                    {formatDuration(t.duration)}
                  </span>
                </div>
              ))}
            </div>
            {tracks.length > 8 && (
              <p className="text-[10px] text-[#5a5f68] px-3 py-2">
                + {tracks.length - 8} more tracks
              </p>
            )}
          </Card>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => handleSelect(savantResult.playlistId)}>
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
          <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-4 py-3 text-sm text-[#ef4444]">
            {savantError}
          </div>
        )}
        <Card>
          <div className="space-y-3">
            <p className="text-sm text-[#8a8f98]">
              Savant uses AI to build a playlist tailored to your mood.
            </p>
            <p className="text-xs text-[#5a5f68]">
              {keyedCount} / {totalCount} tracks have harmonic data (
              {coveragePct}%). Re-scan your library or run backfill to improve.
            </p>
            {totalCount > 0 && coveragePct < 100 && (
              <Button
                size="sm"
                variant="secondary"
                disabled={savantBackfilling}
                onClick={handleSavantBackfill}
              >
                {savantBackfilling ? "Backfilling…" : "Backfill Key Data"}
              </Button>
            )}
          </div>
        </Card>

        <Card title="1. Mood">
          {savantMoodFromChat ? (
            <div className="rounded-lg bg-[#4a9eff]/10 border border-[#4a9eff]/30 p-3">
              <p className="text-[10px] font-semibold text-[#4a9eff] mb-1">
                🎵 Mood from chat
              </p>
              <p className="text-sm text-[#e0e0e0] whitespace-pre-wrap">
                {savantMoodFromChat}
              </p>
              <button
                type="button"
                onClick={() => {
                  setSavantMoodFromChat(null);
                  setSavantChatHistory([]);
                }}
                className="text-[10px] text-[#5a5f68] hover:text-[#8a8f98] mt-2"
              >
                Change mood
              </button>
            </div>
          ) : (
            <>
              {!savantChatActive && (
                <>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {MOOD_CHIPS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSavantMood(savantMood === m ? "" : m)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-default ${
                          savantMood === m
                            ? "bg-[#4a9eff]/20 text-[#4a9eff] border border-[#4a9eff]/40"
                            : "bg-white/[0.04] text-[#8a8f98] border border-white/[0.06] hover:bg-white/[0.08]"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <Input
                    label="Or describe your mood"
                    value={savantMoodCustom}
                    onChange={(e) => setSavantMoodCustom(e.target.value)}
                    placeholder="e.g. Late night coding, rainy afternoon"
                  />
                </>
              )}
              {hasOpenRouterKey && (
                <div className={savantChatActive ? "" : "mt-3"}>
                  <MoodChat
                    onConfirm={(moodSummary, chatHistory) => {
                      setSavantMoodFromChat(moodSummary);
                      setSavantChatHistory(chatHistory);
                      setSavantChatActive(false);
                    }}
                    onSkip={() => setSavantChatActive(false)}
                    onExpandedChange={(expanded) => setSavantChatActive(expanded)}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="2. Seed Artist (optional)">
          <Select
            label="Artist to lean on"
            options={[
              { value: "", label: "None" },
              ...(Array.isArray(savantArtists) ? savantArtists : [])
                .slice(0, 100)
                .map((a) => ({ value: a.name, label: a.name })),
            ]}
            value={savantSeedArtist}
            onChange={(v) => setSavantSeedArtist(v)}
          />
        </Card>

        <Card title="3. Adventure Level">
          <div className="space-y-2">
            {(
              [
                {
                  value: "conservative" as const,
                  label: "Stay close",
                  desc: "Only tracks you've played before",
                },
                {
                  value: "mixed" as const,
                  label: "Mix surprises",
                  desc: "Played + some new discoveries",
                },
                {
                  value: "adventurous" as const,
                  label: "Take me somewhere new",
                  desc: "Full library",
                },
              ]
            ).map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-3 p-3 rounded-lg border border-white/[0.06] hover:bg-white/[0.02] cursor-pointer"
              >
                <input
                  type="radio"
                  name="savant-adventure"
                  checked={savantAdventure === opt.value}
                  onChange={() => setSavantAdventure(opt.value)}
                  className="accent-[#4a9eff]"
                />
                <div>
                  <span className="text-sm font-medium text-white">
                    {opt.label}
                  </span>
                  <p className="text-[11px] text-[#5a5f68]">{opt.desc}</p>
                </div>
              </label>
            ))}
          </div>
          <div className="mt-4">
            <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
              Track count: {savantTargetCount}
            </label>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={savantTargetCount}
              onChange={(e) =>
                setSavantTargetCount(Number(e.target.value))
              }
              className="w-full accent-[#4a9eff]"
            />
          </div>
        </Card>

        <Button
          variant="primary"
          disabled={savantGenerating}
          onClick={handleSavantGenerate}
        >
          {savantGenerating
            ? "Consulting the AI curator…"
            : "Create Playlist"}
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
      <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] w-fit">
        {(["all", "smart", "genius", "savant"] as Tab[]).map((tab) => (
          <button
            key={tab}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors cursor-default capitalize ${
              activeTab === tab
                ? "bg-[#4a9eff]/15 text-[#4a9eff]"
                : "text-[#5a5f68] hover:text-[#8a8f98]"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Savant tab: show flow instead of list */}
      {activeTab === "savant" ? (
        renderSavantFlow()
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-[#4a9eff]/30 border-t-[#4a9eff] rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="≡"
          title="No playlists"
          description="Create a smart or genius playlist to get started"
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowCreate(true)}
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
                <div className="w-10 h-10 rounded-xl bg-[#4a9eff]/[0.08] flex items-center justify-center text-lg text-[#4a9eff]">
                  {p.typeName === "genius" ? "✨" : "≡"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-white truncate">
                      {p.name}
                    </h4>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#4a9eff]/10 text-[#4a9eff] shrink-0">
                      {p.typeName}
                    </span>
                  </div>
                  <p className="text-[10px] text-[#5a5f68] mt-0.5">
                    {p.trackCount} tracks &middot; Updated{" "}
                    {new Date(p.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              {p.description && (
                <p className="text-xs text-[#8a8f98] mb-3 line-clamp-2">
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

      {/* Create Playlist Modal: choice → Smart flow or Genius flow */}
      <Modal
        open={showCreate}
        onClose={closeCreateModal}
        wide={createKind === "genius"}
        title={
          createKind === null
            ? "Create Playlist"
            : createKind === "smart"
              ? createStep === 1
                ? "Create Smart Playlist"
                : "Choose filters"
              : "Create Genius Playlist"
        }
      >
        <div className="space-y-4">
          {createKind === null ? (
            <>
              <p className="text-sm text-[#8a8f98]">
                Choose the type of playlist to create.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setCreateKind("smart");
                    setCreateStep(1);
                  }}
                  className="flex-1 p-4 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-[#4a9eff]/[0.06] hover:border-[#4a9eff]/30 transition-all text-left cursor-pointer"
                >
                  <div className="text-2xl mb-2">≡</div>
                  <h4 className="text-sm font-semibold text-white">
                    Smart Playlist
                  </h4>
                  <p className="text-[11px] text-[#5a5f68] mt-1">
                    Build a playlist by genre, artist, or album.
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
                  className="flex-1 p-4 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:bg-[#4a9eff]/[0.06] hover:border-[#4a9eff]/30 transition-all text-left cursor-pointer"
                >
                  <div className="text-2xl mb-2">✨</div>
                  <h4 className="text-sm font-semibold text-white">
                    Genius Playlist
                  </h4>
                  <p className="text-[11px] text-[#5a5f68] mt-1">
                    Analyze device playback and generate smart playlists.
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
          ) : createStep === 1 ? (
            <>
              <Input
                label="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Playlist"
              />
              <Select
                label="Strategy"
                value={strategy}
                onChange={(v) => setStrategy(v)}
                options={[
                  { value: "by_genre", label: "By Genre" },
                  { value: "by_artist", label: "By Artist" },
                  { value: "by_album", label: "By Album" },
                ]}
              />
              <div>
                <label className="flex items-center gap-2 mb-1.5 cursor-pointer text-xs font-medium text-[#8a8f98]">
                  <input
                    type="checkbox"
                    checked={trackLimitAll}
                    onChange={(e) =>
                      setTrackLimitAll(e.target.checked)
                    }
                    className="accent-[#4a9eff]"
                  />
                  All
                </label>
                <label className="block text-xs font-medium text-[#8a8f98] mb-1.5">
                  Track Limit: {trackLimitAll ? "All" : trackLimit}
                </label>
                <input
                  type="range"
                  min={10}
                  max={500}
                  step={10}
                  value={trackLimit}
                  onChange={(e) =>
                    setTrackLimit(Number(e.target.value))
                  }
                  disabled={trackLimitAll}
                  className={`w-full accent-[#4a9eff] ${trackLimitAll ? "opacity-50 cursor-not-allowed" : ""}`}
                />
                <div className="flex justify-between text-[10px] text-[#5a5f68]">
                  <span>10</span>
                  <span>500</span>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button onClick={closeCreateModal}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={goToStep2}
                  disabled={!newName || optionsLoading}
                >
                  {optionsLoading ? "Loading\u2026" : "Next"}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-[#8a8f98]">
                {strategy === "by_genre" &&
                  "Select one or more genres."}
                {strategy === "by_artist" &&
                  "Select one or more artists."}
                {strategy === "by_album" &&
                  "Select one or more albums."}
              </p>
              <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-black/20 p-2 space-y-1">
                {strategy === "by_genre" &&
                  (Array.isArray(genres) ? genres : []).map((g) => (
                    <label
                      key={g.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/[0.04] cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selectedGenreIds.has(g.id)}
                        onChange={() =>
                          toggleSet(setSelectedGenreIds, g.id)
                        }
                        className="accent-[#4a9eff]"
                      />
                      <span className="text-white truncate">
                        {g.name}
                      </span>
                      <span className="text-[10px] text-[#5a5f68] shrink-0">
                        {g.trackCount} tracks
                      </span>
                    </label>
                  ))}
                {strategy === "by_artist" &&
                  (Array.isArray(artists) ? artists : []).map((a) => (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/[0.04] cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selectedArtistIds.has(a.id)}
                        onChange={() =>
                          toggleSet(setSelectedArtistIds, a.id)
                        }
                        className="accent-[#4a9eff]"
                      />
                      <span className="text-white truncate">
                        {a.name}
                      </span>
                      <span className="text-[10px] text-[#5a5f68] shrink-0">
                        {a.trackCount} tracks
                      </span>
                    </label>
                  ))}
                {strategy === "by_album" &&
                  (Array.isArray(albums) ? albums : []).map((a) => (
                    <label
                      key={a.id}
                      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/[0.04] cursor-pointer text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAlbumIds.has(a.id)}
                        onChange={() =>
                          toggleSet(setSelectedAlbumIds, a.id)
                        }
                        className="accent-[#4a9eff]"
                      />
                      <span className="text-white truncate">
                        {a.title} &mdash; {a.artist}
                      </span>
                      <span className="text-[10px] text-[#5a5f68] shrink-0">
                        {a.trackCount} tracks
                      </span>
                    </label>
                  ))}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button onClick={() => setCreateStep(1)}>Back</Button>
                <Button
                  variant="primary"
                  onClick={handleCreate}
                  disabled={
                    (strategy === "by_genre" &&
                      selectedGenreIds.size === 0) ||
                    (strategy === "by_artist" &&
                      selectedArtistIds.size === 0) ||
                    (strategy === "by_album" &&
                      selectedAlbumIds.size === 0)
                  }
                >
                  Create Playlist
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
