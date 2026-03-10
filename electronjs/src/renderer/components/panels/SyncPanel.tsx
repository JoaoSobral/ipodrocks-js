import { useEffect, useState, useCallback, useMemo } from "react";
import { Card } from "../common/Card";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { useDeviceStore } from "../../stores/device-store";
import { useSyncStore } from "../../stores/sync-store";
import {
  getTracks,
  getPlaylists,
  getPlaylistTracks,
  getShadowLibraries,
  getLibraryStats,
} from "../../ipc/api";
import { SyncProgressModal } from "../modals/SyncProgressModal";
import type { Track, Playlist, ShadowLibrary } from "@shared/types";
import type { CustomSelections, SyncOptions } from "@shared/types";

const statusColors = { success: "#22c55e", error: "#ef4444", warning: "#f5bf42" } as const;
const statusLabels = {
  success: "Success",
  error: "Failed",
  warning: "Completed with warnings",
} as const;

export function SyncPanel() {
  const { devices, fetchDevices } = useDeviceStore();
  const deviceList = Array.isArray(devices) ? devices : [];
  const { results, setResults } = useSyncStore();
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncOptionsForModal, setSyncOptionsForModal] = useState<SyncOptions | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);

  const [deviceId, setDeviceId] = useState<number | "">("");
  const [shadowLibs, setShadowLibs] = useState<ShadowLibrary[]>([]);
  const [syncType, setSyncType] = useState("full");
  const [fullIncludeMusic, setFullIncludeMusic] = useState(true);
  const [fullIncludePodcasts, setFullIncludePodcasts] = useState(true);
  const [fullIncludeAudiobooks, setFullIncludeAudiobooks] = useState(true);
  const [fullIncludePlaylists, setFullIncludePlaylists] = useState(true);
  const [extraTrackPolicy, setExtraTrackPolicy] = useState("keep");
  const [ignoreSpaceCheck, setIgnoreSpaceCheck] = useState(false);

  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistAffectedAlbums, setPlaylistAffectedAlbums] = useState<Set<string>>(new Set());
  const [playlistAffectedArtists, setPlaylistAffectedArtists] = useState<Set<string>>(new Set());
  const [playlistAffectedGenres, setPlaylistAffectedGenres] = useState<Set<string>>(new Set());
  const [selectedItems, setSelectedItems] = useState<Record<string, Set<string>>>({
    albums: new Set(),
    artists: new Set(),
    genres: new Set(),
    podcasts: new Set(),
    audiobooks: new Set(),
    playlists: new Set(),
  });

  const albums = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const seen = new Set<string>();
    list
      .filter((t) => (t?.contentType || "music") === "music")
      .forEach((t) => {
        const a = (t?.album || "Unknown Album").trim();
        const r = (t?.artist || "Unknown Artist").trim();
        seen.add(`${a} — ${r}`);
      });
    return [...seen].sort();
  }, [tracks]);

  const artists = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const seen = new Set<string>();
    list
      .filter((t) => (t?.contentType || "music") === "music")
      .forEach((t) => seen.add((t?.artist || "Unknown Artist").trim()));
    return [...seen].sort();
  }, [tracks]);

  const genres = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const seen = new Set<string>();
    list
      .filter((t) => (t?.contentType || "music") === "music")
      .forEach((t) => seen.add((t?.genre || "Unknown Genre").trim()));
    return [...seen].sort();
  }, [tracks]);

  const podcasts = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const seen = new Set<string>();
    list
      .filter((t) => (t?.contentType || "music") === "podcast")
      .forEach((t) => {
        const title = (t?.title ?? t?.filename ?? "Untitled").trim();
        const artist = (t?.artist ?? "").trim();
        seen.add(artist ? `${title} — ${artist}` : title);
      });
    return [...seen].sort();
  }, [tracks]);

  const audiobooks = useMemo(() => {
    const list = Array.isArray(tracks) ? tracks : [];
    const seen = new Set<string>();
    list
      .filter((t) => (t?.contentType || "music") === "audiobook")
      .forEach((t) => {
        const title = (t?.title ?? t?.filename ?? "Untitled").trim();
        const artist = (t?.artist ?? "").trim();
        seen.add(artist ? `${title} — ${artist}` : title);
      });
    return [...seen].sort();
  }, [tracks]);

  const playlistNames = useMemo(
    () => [...new Set((Array.isArray(playlists) ? playlists : []).map((p) => p?.name ?? ""))].sort(),
    [playlists]
  );

  const selectedPlaylistsKey = useMemo(
    () => [...selectedItems.playlists].sort().join("\0"),
    [selectedItems.playlists]
  );

  useEffect(() => {
    if (syncType !== "custom" || selectedItems.playlists.size === 0 || (Array.isArray(playlists) ? playlists : []).length === 0) {
      setPlaylistAffectedAlbums(new Set());
      setPlaylistAffectedArtists(new Set());
      setPlaylistAffectedGenres(new Set());
      return;
    }
    let cancelled = false;
    const albumSet = new Set<string>();
    const artistSet = new Set<string>();
    const genreSet = new Set<string>();
    (async () => {
      const plList = Array.isArray(playlists) ? playlists : [];
      for (const name of selectedItems.playlists) {
        const pl = plList.find((p) => (p?.name ?? "") === name);
        if (!pl || cancelled) continue;
        try {
          const playlistTracks = await getPlaylistTracks(pl.id);
          for (const t of playlistTracks) {
            const album = (t.album ?? "Unknown Album").trim();
            const artist = (t.artist ?? "Unknown Artist").trim();
            const genre = (t.genre ?? "Unknown Genre").trim();
            albumSet.add(`${album} — ${artist}`);
            artistSet.add(artist);
            genreSet.add(genre);
          }
        } catch {
          // ignore
        }
      }
      if (!cancelled) {
        setPlaylistAffectedAlbums(albumSet);
        setPlaylistAffectedArtists(artistSet);
        setPlaylistAffectedGenres(genreSet);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncType, playlists, selectedPlaylistsKey]);

  const affectedItems = useMemo(() => {
    const selected: Record<string, Set<string>> = {
      albums: new Set(),
      artists: new Set(),
      genres: new Set(),
      podcasts: new Set(),
      audiobooks: new Set(),
      playlists: new Set(),
    };
    const partial: Record<string, Set<string>> = {
      albums: new Set(),
      artists: new Set(),
      genres: new Set(),
      podcasts: new Set(),
      audiobooks: new Set(),
      playlists: new Set(),
    };

    const trackList = Array.isArray(tracks) ? tracks : [];
    const musicTracks = trackList.filter((t) => (t?.contentType || "music") === "music");
    const podcastTracks = trackList.filter((t) => (t?.contentType || "music") === "podcast");
    const audiobookTracks = trackList.filter((t) => (t?.contentType || "music") === "audiobook");

    const syncMusic = (t: Track) => {
      const album = (t.album ?? "Unknown Album").trim();
      const artist = (t.artist ?? "Unknown Artist").trim();
      const genre = (t.genre ?? "Unknown Genre").trim();
      const albumLabel = `${album} — ${artist}`;
      return (
        selectedItems.albums.has(albumLabel) ||
        selectedItems.artists.has(artist) ||
        selectedItems.genres.has(genre)
      );
    };
    const syncPodcast = (t: Track) => {
      const title = (t.title ?? t.filename ?? "Untitled").trim();
      const artist = (t.artist ?? "").trim();
      const label = artist ? `${title} — ${artist}` : title;
      return selectedItems.podcasts.has(label) || selectedItems.podcasts.has(title);
    };
    const syncAudiobook = (t: Track) => {
      const title = (t.title ?? t.filename ?? "Untitled").trim();
      const artist = (t.artist ?? "").trim();
      const label = artist ? `${title} — ${artist}` : title;
      return selectedItems.audiobooks.has(label) || selectedItems.audiobooks.has(title);
    };

    const syncedMusic = musicTracks.filter(syncMusic);
    const syncedPodcast = podcastTracks.filter(syncPodcast);
    const syncedAudiobook = audiobookTracks.filter(syncAudiobook);

    const syncedAlbums = new Set<string>();
    const syncedArtists = new Set<string>();
    const syncedGenres = new Set<string>();
    const syncedPodcastLabels = new Set<string>();
    const syncedAudiobookLabels = new Set<string>();

    syncedMusic.forEach((t) => {
      const a = (t.album ?? "Unknown Album").trim();
      const r = (t.artist ?? "Unknown Artist").trim();
      const g = (t.genre ?? "Unknown Genre").trim();
      syncedAlbums.add(`${a} — ${r}`);
      syncedArtists.add(r);
      syncedGenres.add(g);
    });
    syncedPodcast.forEach((t) => {
      const title = (t.title ?? t.filename ?? "Untitled").trim();
      const artist = (t.artist ?? "").trim();
      syncedPodcastLabels.add(artist ? `${title} — ${artist}` : title);
    });
    syncedAudiobook.forEach((t) => {
      const title = (t.title ?? t.filename ?? "Untitled").trim();
      const artist = (t.artist ?? "").trim();
      syncedAudiobookLabels.add(artist ? `${title} — ${artist}` : title);
    });

    [syncedAlbums, syncedArtists, syncedGenres].forEach((set, i) => {
      const key = ["albums", "artists", "genres"][i];
      set.forEach((label) => {
        if (selectedItems[key].has(label)) selected[key].add(label);
        else partial[key].add(label);
      });
    });
    syncedPodcastLabels.forEach((label) => {
      if (selectedItems.podcasts.has(label)) selected.podcasts.add(label);
      else partial.podcasts.add(label);
    });
    syncedAudiobookLabels.forEach((label) => {
      if (selectedItems.audiobooks.has(label)) selected.audiobooks.add(label);
      else partial.audiobooks.add(label);
    });
    selectedItems.playlists.forEach((name) => selected.playlists.add(name));

    playlistAffectedAlbums.forEach((label) => {
      if (!selected.albums.has(label)) partial.albums.add(label);
    });
    playlistAffectedArtists.forEach((label) => {
      if (!selected.artists.has(label)) partial.artists.add(label);
    });
    playlistAffectedGenres.forEach((label) => {
      if (!selected.genres.has(label)) partial.genres.add(label);
    });

    return { selected, partial };
  }, [
    tracks,
    selectedItems,
    playlistAffectedAlbums,
    playlistAffectedArtists,
    playlistAffectedGenres,
  ]);

  const toggleSelection = useCallback((category: string, label: string, checked: boolean) => {
    setSelectedItems((prev) => {
      const next = { ...prev, [category]: new Set(prev[category]) };
      if (checked) next[category].add(label);
      else next[category].delete(label);
      return next;
    });
  }, []);

  useEffect(() => {
    fetchDevices();
    getShadowLibraries().then(setShadowLibs).catch(console.error);
  }, [fetchDevices]);

  useEffect(() => {
    if (syncType === "custom") {
      getTracks().then(setTracks).catch(console.error);
      getPlaylists().then(setPlaylists).catch(console.error);
    }
  }, [syncType]);

  useEffect(() => {
    if (deviceList.length > 0 && !deviceId) {
      setDeviceId(deviceList[0]?.id ?? "");
    }
  }, [deviceList, deviceId]);

  const selectedDevice = useMemo(
    () => (deviceId ? deviceList.find((d) => d?.id === deviceId) : undefined),
    [deviceList, deviceId]
  );

  const transferModeLabel = useMemo(() => {
    if (!selectedDevice) return null;
    const src = selectedDevice.sourceLibraryType ?? "primary";
    const codecName = selectedDevice.codecName ?? "DIRECT COPY";
    const isDirect = codecName.toUpperCase() === "DIRECT COPY";

    if (src === "shadow" && selectedDevice.shadowLibraryId != null) {
      const shadow = shadowLibs.find(
        (s) => s.id === selectedDevice.shadowLibraryId
      );
      const shadowLabel = shadow
        ? `${shadow.name} (${shadow.codecName})`
        : `Shadow #${selectedDevice.shadowLibraryId}`;
      return { mode: "Direct Copy", source: shadowLabel, color: "#a78bfa" };
    }
    if (isDirect) {
      return { mode: "Direct Copy", source: "Primary Library", color: "#22c55e" };
    }
    return { mode: "Transcode", source: codecName, color: "#f5bf42" };
  }, [selectedDevice, shadowLibs]);

  const handleStart = useCallback(() => {
    void (async () => {
      if (!deviceId || !selectedDevice) return;
      setPrecheckError(null);

      try {
        if (
          (selectedDevice.sourceLibraryType ?? "primary") === "shadow" &&
          selectedDevice.shadowLibraryId != null
        ) {
          const shadow = shadowLibs.find((s) => s.id === selectedDevice.shadowLibraryId);
          if (!shadow || shadow.status !== "ready" || shadow.trackCount <= 0) {
            setPrecheckError(
              "Shadow library contains no files to sync. Build or select a shadow library that has tracks."
            );
            return;
          }
        } else {
          const stats = await getLibraryStats();
          const hasTracks =
            (stats.totalTracks ?? 0) > 0 ||
            (stats.podcastTrackCount ?? 0) > 0 ||
            (stats.audiobookTrackCount ?? 0) > 0;
          if (!hasTracks) {
            setPrecheckError(
              "Library contains no music, podcast, or audiobook files to sync. Add library folders and scan first."
            );
            return;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setPrecheckError(msg || "Unable to check library contents before sync.");
        return;
      }

    const selections: CustomSelections | undefined =
      syncType === "custom"
        ? {
            albums: [...selectedItems.albums],
            artists: [...selectedItems.artists],
            genres: [...selectedItems.genres],
            podcasts: [...selectedItems.podcasts],
            audiobooks: [...selectedItems.audiobooks],
            playlists: [...selectedItems.playlists],
          }
        : undefined;
    setResults(null);
    setSyncOptionsForModal({
      deviceId: deviceId as number,
      syncType,
      extraTrackPolicy,
      ignoreSpaceCheck,
      selections,
      ...(syncType === "full" && {
        includeMusic: fullIncludeMusic,
        includePodcasts: fullIncludePodcasts,
        includeAudiobooks: fullIncludeAudiobooks,
        includePlaylists: fullIncludePlaylists,
      }),
    });
    setShowSyncModal(true);
    })();
  }, [
    deviceId,
    selectedDevice,
    shadowLibs,
    syncType,
    fullIncludeMusic,
    fullIncludePodcasts,
    fullIncludeAudiobooks,
    fullIncludePlaylists,
    extraTrackPolicy,
    ignoreSpaceCheck,
    selectedItems,
    setResults,
  ]);

  return (
    <div className="panel-content flex flex-col gap-5">
      {/* Device selector */}
      <Card>
        <Select
          label="Target Device"
          value={String(deviceId)}
          onChange={(v) => setDeviceId(Number(v))}
          options={deviceList.map((d) => ({ value: String(d?.id ?? ""), label: d?.name ?? "" }))}
        />
        {transferModeLabel && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs"
            style={{
              backgroundColor: `${transferModeLabel.color}10`,
              border: `1px solid ${transferModeLabel.color}30`,
            }}
          >
            <span
              className="inline-block h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: transferModeLabel.color }}
            />
            <span className="text-[#e0e0e0]">
              <span className="font-medium" style={{ color: transferModeLabel.color }}>
                {transferModeLabel.mode}
              </span>
              {" — "}
              {transferModeLabel.source}
            </span>
          </div>
        )}
      </Card>

      {/* Configuration */}
      <Card title="Sync Configuration">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-[#8a8f98] mb-2">Sync Type</p>
            <div className="flex gap-4">
              {(["full", "custom"] as const).map((type) => (
                <label key={type} className="flex items-center gap-2 cursor-default">
                  <input
                    type="radio"
                    name="syncType"
                    checked={syncType === type}
                    onChange={() => setSyncType(type)}
                    className="accent-[#4a9eff]"
                  />
                  <span className="text-sm text-[#e0e0e0] capitalize">{type}</span>
                </label>
              ))}
            </div>
            {syncType === "full" && (
              <div className="flex flex-wrap gap-6 mt-3 pl-5 border-l-2 border-white/[0.06]">
                <label className="flex items-center gap-2 cursor-default">
                  <input
                    type="checkbox"
                    checked={fullIncludeMusic}
                    onChange={(e) => setFullIncludeMusic(e.target.checked)}
                    className="accent-[#4a9eff] rounded"
                  />
                  <span className="text-sm text-[#e0e0e0]">Music</span>
                </label>
                <label className="flex items-center gap-2 cursor-default">
                  <input
                    type="checkbox"
                    checked={fullIncludePodcasts}
                    onChange={(e) => setFullIncludePodcasts(e.target.checked)}
                    className="accent-[#4a9eff] rounded"
                  />
                  <span className="text-sm text-[#e0e0e0]">Podcasts</span>
                </label>
                <label className="flex items-center gap-2 cursor-default">
                  <input
                    type="checkbox"
                    checked={fullIncludeAudiobooks}
                    onChange={(e) => setFullIncludeAudiobooks(e.target.checked)}
                    className="accent-[#4a9eff] rounded"
                  />
                  <span className="text-sm text-[#e0e0e0]">Audiobooks</span>
                </label>
                <label className="flex items-center gap-2 cursor-default">
                  <input
                    type="checkbox"
                    checked={fullIncludePlaylists}
                    onChange={(e) => setFullIncludePlaylists(e.target.checked)}
                    className="accent-[#4a9eff] rounded"
                  />
                  <span className="text-sm text-[#e0e0e0]">Playlists</span>
                </label>
              </div>
            )}
          </div>
          <Select
            label="Orphan Policy"
            value={extraTrackPolicy}
            onChange={(v) => setExtraTrackPolicy(v)}
            options={[
              { value: "remove", label: "Remove" },
              { value: "keep", label: "Keep" },
              { value: "prompt", label: "Prompt" },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 mt-4 cursor-default">
          <input
            type="checkbox"
            checked={ignoreSpaceCheck}
            onChange={(e) => setIgnoreSpaceCheck(e.target.checked)}
            className="accent-[#4a9eff] rounded"
          />
          <span className="text-sm text-[#8a8f98]">Ignore space check</span>
        </label>
      </Card>

      {/* Custom sync: grid of categories */}
      {syncType === "custom" && (
        <Card title="Choose what to sync">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { key: "albums", title: "Albums", items: albums },
              { key: "artists", title: "Artists", items: artists },
              { key: "genres", title: "Genres", items: genres },
              { key: "podcasts", title: "Podcasts", items: podcasts },
              { key: "audiobooks", title: "Audiobooks", items: audiobooks },
              { key: "playlists", title: "Playlists", items: playlistNames },
            ].map(({ key, title, items }) => (
              <div
                key={key}
                className="theme-box rounded-lg border border-[#2a2d33] bg-[#1c1e22] p-3 flex flex-col max-h-[350px]"
              >
                <p className="text-xs font-medium text-[#8a8f98] mb-2 shrink-0">{title}</p>
                <div className="min-h-0 flex-1 overflow-y-auto space-y-1">
                  {items.length === 0 ? (
                    <p className="text-xs text-[#5a5f68]">No items</p>
                  ) : (
                    items.map((label) => {
                      const isSelected = affectedItems.selected[key].has(label);
                      const isPartial = affectedItems.partial[key].has(label);
                      const checked = isSelected || isPartial;
                      const bg =
                        isSelected ? "bg-[#22c55e]/20 text-[#22c55e]" :
                        isPartial ? "bg-[#f5bf42]/20 text-[#f5bf42]" : "";
                      const pl = key === "playlists" ? (Array.isArray(playlists) ? playlists : []).find((p) => (p?.name ?? "") === label) : null;
                      const typeLabel =
                        pl?.typeName === "genius" ? "Genius" : pl?.typeName === "smart" ? "Smart" : null;
                      return (
                        <label
                          key={label}
                          className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-xs truncate ${bg}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelection(key, label, !isSelected)}
                            className="accent-[#4a9eff] rounded"
                          />
                          <span className="truncate min-w-0">{label}</span>
                          {typeLabel && (
                            <span
                              className="shrink-0 text-[10px] font-medium opacity-90"
                              title={typeLabel}
                            >
                              {typeLabel === "Genius" ? "✨" : "≡"}
                            </span>
                          )}
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Start button */}
      {precheckError && (
        <div className="rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 px-3 py-2 text-sm text-[#ef4444] max-w-lg">
          {precheckError}
        </div>
      )}
      <Button
        variant="primary"
        size="sm"
        className="self-start"
        onClick={handleStart}
        disabled={!deviceId}
      >
        Start Sync
      </Button>

      {/* Sync progress modal */}
      {showSyncModal && syncOptionsForModal && (
        <SyncProgressModal
          open={showSyncModal}
          onClose={() => {
            setShowSyncModal(false);
            setSyncOptionsForModal(null);
          }}
          syncOptions={syncOptionsForModal}
          onComplete={(r) => {
            setResults({
              synced: r.synced,
              skipped: r.skipped,
              removed: 0,
              errors: r.errors,
              status: r.status,
            });
          }}
        />
      )}

      {/* Results */}
      {results && (
        <Card title="Sync Results">
          <div className="flex items-center gap-3 mb-4">
            <span
              className="px-2.5 py-1 rounded-full text-xs font-medium"
              style={{
                backgroundColor: `${statusColors[results.status]}15`,
                color: statusColors[results.status],
              }}
            >
              {statusLabels[results.status]}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Synced", value: results.synced, color: "#22c55e" },
              { label: "Skipped", value: results.skipped, color: "#8a8f98" },
              { label: "Removed", value: results.removed, color: "#f5bf42" },
              { label: "Errors", value: results.errors, color: "#ef4444" },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="text-xl font-bold" style={{ color: stat.color }}>
                  {stat.value}
                </p>
                <p className="text-[10px] text-[#5a5f68]">{stat.label}</p>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
