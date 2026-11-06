import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { Input } from "../common/Input";
import { Modal } from "../common/Modal";
import { Spinner } from "../common/Spinner";
import {
  addRemoteLibrary,
  evictRemoteOffline,
  isDenied,
  keepRemoteOffline,
  listRemoteLibraries,
  listRemoteTracks,
  refreshRemoteLibrary,
  remoteStreamUrl,
  removeRemoteLibrary,
  type RemoteLibrary,
  type RemoteTrack,
} from "../../ipc/api";

/**
 * Library → Remote libraries. Web mode only.
 *
 * A remote library is a friend's iPodRocks share, reached server to server.
 * Its tracks are browsed and played from here; "Keep offline" downloads them
 * into a managed folder, after which they are ordinary library tracks — which
 * is what puts them in the Tracks list above and lets a sync copy them to an
 * iPod. Nothing in this card talks to the friend's server directly: every
 * byte goes through this server.
 */

const STATUS: Record<RemoteLibrary["status"], { label: string; dot: string }> = {
  active: { label: "Online", dot: "bg-success" },
  offline: { label: "Offline", dot: "bg-muted-foreground" },
  revoked: { label: "No longer shared", dot: "bg-destructive" },
  error: { label: "Needs attention", dot: "bg-warning" },
};

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function albumKey(t: RemoteTrack): string {
  return `${t.albumArtist ?? t.artist ?? "Unknown artist"} — ${t.album ?? "Unknown album"}`;
}

export function RemoteLibrariesCard({ onLibraryChanged }: { onLibraryChanged?: () => void }) {
  const [libraries, setLibraries] = useState<RemoteLibrary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState<RemoteLibrary | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const result = await listRemoteLibraries();
    if (isDenied(result)) {
      setError(result.error);
      setLibraries([]);
      return;
    }
    setError(null);
    setLibraries(result.libraries);
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function refresh(lib: RemoteLibrary) {
    setBusy(lib.id);
    try {
      const r = await refreshRemoteLibrary(lib.id);
      if (isDenied(r)) toast.error(r.error);
      else toast.success(`${lib.name}: ${r.trackCount} tracks`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(lib: RemoteLibrary) {
    if (
      !window.confirm(
        `Remove "${lib.name}"? Its ${lib.cachedCount} offline cop${lib.cachedCount === 1 ? "y" : "ies"} will be deleted from this server and from the library.`
      )
    ) {
      return;
    }
    setBusy(lib.id);
    try {
      const r = await removeRemoteLibrary(lib.id);
      if (isDenied(r)) toast.error(r.error);
      await load();
      onLibraryChanged?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="!p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-[11px] font-semibold text-card-foreground">Remote libraries</h3>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)} data-testid="remote-add-open">
          + Add remote library
        </Button>
      </div>
      {error && <p className="text-[11px] text-muted-foreground">{error}</p>}
      {libraries?.length === 0 && !error && (
        <p className="text-[11px] text-muted-foreground">
          When a friend shares their iPodRocks library with you, paste their invite link here.
        </p>
      )}
      <ul className="space-y-1" data-testid="remote-libraries">
        {libraries?.map((lib) => (
          <li
            key={lib.id}
            className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
            data-testid={`remote-library-${lib.id}`}
          >
            <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS[lib.status].dot}`} title={STATUS[lib.status].label} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-foreground truncate">
                {lib.name}{" "}
                <span className="text-muted-foreground">
                  · Remote · {lib.trackCount} tracks · {gb(lib.totalBytes)} · {lib.cachedCount} offline
                </span>
              </p>
              <p className="text-[10px] text-muted-foreground truncate" title={lib.lastError ?? undefined}>
                {STATUS[lib.status].label}
                {lib.lastError && lib.status !== "active" ? ` — ${lib.lastError}` : ""}
                {` · ${lib.peerOrigin} · key ${lib.sharerFingerprint}`}
              </p>
            </div>
            {busy === lib.id ? (
              <Spinner />
            ) : (
              <div className="flex gap-1 shrink-0">
                <Button
                  size="sm"
                  disabled={lib.status === "revoked"}
                  onClick={() => setBrowsing(lib)}
                  data-testid={`remote-browse-${lib.id}`}
                >
                  Browse
                </Button>
                <Button size="sm" variant="ghost" disabled={lib.status === "revoked"} onClick={() => void refresh(lib)}>
                  ⟳
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(lib)} data-testid={`remote-remove-${lib.id}`}>
                  ✕
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {adding && (
        <AddRemoteLibraryModal
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {browsing && (
        <RemoteLibraryBrowser
          library={browsing}
          onClose={() => {
            setBrowsing(null);
            void load();
          }}
          onLibraryChanged={onLibraryChanged}
        />
      )}
    </Card>
  );
}

function AddRemoteLibraryModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [lan, setLan] = useState(false);
  const [cfId, setCfId] = useState("");
  const [cfSecret, setCfSecret] = useState("");
  const [showCf, setShowCf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await addRemoteLibrary({
        inviteLink: link.trim(),
        name: name.trim() || undefined,
        lan,
        cfClientId: cfId.trim() || undefined,
        cfClientSecret: cfSecret.trim() || undefined,
      });
      if (isDenied(r)) {
        setError(r.error);
        return;
      }
      toast.success(`Added ${r.library.name} — ${r.library.trackCount} tracks (key ${r.library.sharerFingerprint})`);
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add a remote library">
      <div className="space-y-3" data-testid="remote-add-form">
        <Input
          label="Invite link"
          placeholder="https://their-server/#share=…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          data-testid="remote-invite-link"
        />
        <Input label="Name (optional)" placeholder="e.g. Ana's library" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} data-testid="remote-lan" />
          <span>
            Their server is on my LAN or tailnet
            <span className="block text-muted-foreground">
              Allows a private address (192.168.x, 10.x, Tailscale 100.x) and plain http for this one server.
              Leave off for anything on the internet.
            </span>
          </span>
        </label>
        <button type="button" className="text-xs text-primary" onClick={() => setShowCf((v) => !v)}>
          {showCf ? "Hide" : "Their server is behind Cloudflare Access…"}
        </button>
        {showCf && (
          <div className="grid grid-cols-2 gap-2">
            <Input label="Service token client id" value={cfId} onChange={(e) => setCfId(e.target.value)} />
            <Input label="Service token secret" type="password" value={cfSecret} onChange={(e) => setCfSecret(e.target.value)} />
          </div>
        )}
        {error && (
          <p className="text-xs text-destructive" data-testid="remote-add-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !link.trim()} onClick={() => void submit()} data-testid="remote-add-submit">
            {busy ? "Connecting…" : "Add"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RemoteLibraryBrowser({
  library,
  onClose,
  onLibraryChanged,
}: {
  library: RemoteLibrary;
  onClose: () => void;
  onLibraryChanged?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [tracks, setTracks] = useState<RemoteTrack[]>([]);
  const [total, setTotal] = useState(0);
  const [showDupes, setShowDupes] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  const load = useCallback(async () => {
    const r = await listRemoteTracks(library.id, { search, limit: 2000, hideLocalDuplicates: !showDupes });
    if (isDenied(r)) {
      toast.error(r.error);
      return;
    }
    setTracks(r.tracks);
    setTotal(r.total);
  }, [library.id, search, showDupes]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  const albums = useMemo(() => {
    const m = new Map<string, RemoteTrack[]>();
    for (const t of tracks) {
      const k = albumKey(t);
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return [...m.entries()];
  }, [tracks]);

  async function play(t: RemoteTrack) {
    const r = await remoteStreamUrl(t.id);
    if (isDenied(r)) {
      toast.error(r.error);
      return;
    }
    setPlaying(t.id);
    if (audio.current) {
      audio.current.src = r.url;
      void audio.current.play().catch(() => toast.error("This browser could not play that format."));
    }
  }

  async function keep(key: string, ids: number[]) {
    setBusy(key);
    try {
      const r = await keepRemoteOffline(library.id, ids);
      if (isDenied(r)) {
        toast.error(r.error);
      } else {
        if (r.downloaded > 0) toast.success(`${r.downloaded} track(s) kept offline — they are now in your library`);
        if (r.failed > 0) toast.error(`${r.failed} failed: ${r.errors[0] ?? ""}`);
        onLibraryChanged?.();
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function evict(key: string, ids: number[]) {
    setBusy(key);
    try {
      const r = await evictRemoteOffline(library.id, ids);
      if (isDenied(r)) toast.error(r.error);
      onLibraryChanged?.();
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={`${library.name} — ${library.peerOrigin}`} wide>
      <div className="space-y-2" data-testid="remote-browser">
        <div className="flex items-center gap-2">
          <Input
            className="flex-1"
            placeholder="Search title, artist or album…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
            <input type="checkbox" checked={showDupes} onChange={(e) => setShowDupes(e.target.checked)} />
            Show tracks I already have
          </label>
        </div>
        {!library.allowDownload && (
          <p className="text-[11px] text-muted-foreground">
            The owner has turned off offline copies for this share: you can play it, but not keep it or sync it.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          {total} track(s){total > tracks.length ? `, showing ${tracks.length}` : ""}
        </p>
        <audio ref={audio} controls className="w-full h-8" onEnded={() => setPlaying(null)} />
        <div className="max-h-[50vh] overflow-y-auto space-y-3 pr-1">
          {albums.map(([key, list]) => {
            const notCached = list.filter((t) => !t.cached).map((t) => t.id);
            const cached = list.filter((t) => t.cached).map((t) => t.id);
            return (
              <section key={key} data-testid="remote-album">
                <div className="flex items-center justify-between gap-2 border-b border-border pb-1 mb-1">
                  <h4 className="text-xs font-semibold text-foreground truncate">{key}</h4>
                  <div className="flex gap-1 shrink-0">
                    {busy === key ? (
                      <Spinner />
                    ) : (
                      <>
                        {library.allowDownload && notCached.length > 0 && (
                          <Button size="sm" onClick={() => void keep(key, notCached)} data-testid="remote-keep-album">
                            Keep offline
                          </Button>
                        )}
                        {cached.length > 0 && (
                          <Button size="sm" variant="ghost" onClick={() => void evict(key, cached)}>
                            Remove offline copy
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <ul>
                  {list.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-[11px] py-0.5" data-testid="remote-track">
                      <button
                        type="button"
                        className={`w-5 text-center ${playing === t.id ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                        onClick={() => void play(t)}
                        title="Play"
                        data-testid="remote-play"
                      >
                        ▶
                      </button>
                      <span className="w-6 text-right text-muted-foreground tabular-nums">{t.trackNumber ?? ""}</span>
                      <span className="flex-1 min-w-0 truncate text-foreground">{t.title ?? "Untitled"}</span>
                      {t.localDuplicate && <span className="text-muted-foreground">already in library</span>}
                      {t.cached && (
                        <span className="text-success" title="Kept offline — in your library and syncable">
                          ● offline
                        </span>
                      )}
                      <span className="text-muted-foreground uppercase">{t.codec ?? ""}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
