import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { Input } from "../common/Input";
import {
  createShare,
  deleteShare,
  getLibraryFolders,
  getPlaylists,
  isDenied,
  listShares,
  revokeShare,
  type LibraryShare,
} from "../../ipc/api";

/**
 * Settings → Sharing. Web mode only, owner only (the channels refuse anyone
 * else, and this card renders that refusal as a sentence).
 *
 * A share hands chosen folders and playlists to *another iPodRocks server* —
 * a friend's — through a single-use invite link. Nothing here admits a person
 * to this server; that is the allowlist's job, on the Web Server card.
 */

const GB = 1024 ** 3;

function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "never";
}

const STATUS_LABEL: Record<LibraryShare["status"], string> = {
  pending: "Waiting for the invite to be used",
  expired: "Invite expired",
  active: "Active",
  revoked: "Revoked",
};

export function SharingCard({ open }: { open: boolean }) {
  const [shares, setShares] = useState<LibraryShare[]>([]);
  const [folders, setFolders] = useState<{ id: number; name: string }[]>([]);
  const [playlists, setPlaylists] = useState<{ id: number; name: string }[]>([]);
  const [denied, setDenied] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ label: string; link: string } | null>(null);

  const [label, setLabel] = useState("");
  const [folderIds, setFolderIds] = useState<number[]>([]);
  const [playlistIds, setPlaylistIds] = useState<number[]>([]);
  const [allowDownload, setAllowDownload] = useState(true);
  const [dailyGb, setDailyGb] = useState("");

  const load = useCallback(async () => {
    const result = await listShares();
    if (isDenied(result)) {
      setDenied(result.error);
      return;
    }
    setDenied(null);
    setShares(result.shares);
    const [f, p] = await Promise.all([getLibraryFolders(), getPlaylists()]);
    // A remote library's offline cache is not ours to re-share.
    setFolders(f.filter((x) => !x.name.startsWith("Remote · ")).map((x) => ({ id: x.id, name: x.name })));
    setPlaylists(p.map((x) => ({ id: x.id, name: x.name })));
  }, []);

  useEffect(() => {
    if (open) void load().catch(() => undefined);
  }, [open, load]);

  function toggle(list: number[], id: number): number[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submit() {
    setBusy(true);
    try {
      const gb = Number(dailyGb);
      const result = await createShare({
        label,
        folderIds,
        playlistIds,
        allowDownload,
        byteBudgetDaily: Number.isFinite(gb) && gb > 0 ? Math.floor(gb * GB) : null,
      });
      if (isDenied(result)) {
        toast.error(result.error);
        return;
      }
      setInvite({ label: result.share.label, link: result.inviteLink });
      setCreating(false);
      setLabel("");
      setFolderIds([]);
      setPlaylistIds([]);
      setDailyGb("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      const result = await fn();
      if (isDenied(result as object)) toast.error((result as { error: string }).error);
      else toast.success(done);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <Card title="Sharing" subtitle="Share folders and playlists with a friend's iPodRocks server.">
        <p className="text-xs text-muted-foreground" data-testid="sharing-denied">
          {denied}
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Sharing"
      subtitle="Let a friend's or family member's own iPodRocks server browse, play and keep copies of chosen folders and playlists."
      action={
        !creating && (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)} data-testid="share-new">
            Share my library
          </Button>
        )
      }
    >
      <div className="space-y-4" data-testid="sharing-card">
        {invite && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2" data-testid="share-invite">
            <p className="text-xs text-foreground">
              Send this link to <strong>{invite.label}</strong>. It works once and expires in 7 days.
              They paste it into Library → Remote libraries on their own server.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={invite.link}
                className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono"
                data-testid="share-invite-link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(invite.link).then(
                    () => toast.success("Invite link copied"),
                    () => toast.error("Copy failed — select the link and copy it by hand")
                  );
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setInvite(null)}>
                Done
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Anyone signed in to their server will see these tracks. Treat the link like a password
              until it has been used.
            </p>
          </div>
        )}

        {creating && (
          <div className="rounded-lg border border-border p-3 space-y-3" data-testid="share-form">
            <Input
              label="Who is this for?"
              placeholder="e.g. Ana"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="share-label"
            />
            <div className="grid grid-cols-2 gap-3">
              <fieldset>
                <legend className="text-xs font-medium text-foreground mb-1">Folders</legend>
                {folders.length === 0 && <p className="text-xs text-muted-foreground">No library folders.</p>}
                {folders.map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-xs py-0.5">
                    <input
                      type="checkbox"
                      checked={folderIds.includes(f.id)}
                      onChange={() => setFolderIds((l) => toggle(l, f.id))}
                      data-testid={`share-folder-${f.id}`}
                    />
                    {f.name}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="text-xs font-medium text-foreground mb-1">Playlists</legend>
                {playlists.length === 0 && <p className="text-xs text-muted-foreground">No playlists.</p>}
                {playlists.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-xs py-0.5">
                    <input
                      type="checkbox"
                      checked={playlistIds.includes(p.id)}
                      onChange={() => setPlaylistIds((l) => toggle(l, p.id))}
                    />
                    {p.name}
                  </label>
                ))}
              </fieldset>
            </div>
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={allowDownload}
                onChange={(e) => setAllowDownload(e.target.checked)}
                data-testid="share-allow-download"
              />
              <span>
                Allow offline copies (needed for them to sync these tracks to an iPod).
                <span className="block text-muted-foreground">
                  Streaming still moves the audio, so this is a request their server honours, not a
                  technical barrier. The daily limit below is enforced.
                </span>
              </span>
            </label>
            <Input
              label="Daily transfer limit (GB, optional)"
              type="number"
              min={0}
              step="0.5"
              value={dailyGb}
              onChange={(e) => setDailyGb(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !label.trim() || (folderIds.length === 0 && playlistIds.length === 0)}
                onClick={() => void submit()}
                data-testid="share-create"
              >
                Create invite link
              </Button>
            </div>
          </div>
        )}

        {shares.length === 0 && !creating && (
          <p className="text-xs text-muted-foreground">Nothing is shared.</p>
        )}

        <ul className="space-y-2">
          {shares.map((s) => (
            <li key={s.id} className="rounded-lg border border-border px-3 py-2" data-testid={`share-row-${s.id}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {s.label}{" "}
                    <span className="text-xs text-muted-foreground">— {STATUS_LABEL[s.status]}</span>
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.scope.folderIds.length} folder(s), {s.scope.playlistIds.length} playlist(s)
                    {s.allowDownload ? " · offline copies allowed" : " · stream only"}
                    {s.byteBudgetDaily ? ` · ${formatBytes(s.byteBudgetDaily)}/day` : ""}
                  </p>
                  {s.peerFingerprint && (
                    <p className="text-xs text-muted-foreground truncate">
                      Accepted by {s.peerName ?? "a server"} · key {s.peerFingerprint} · last seen{" "}
                      {when(s.lastSeenAt)} · {formatBytes(s.bytesServed)} served
                    </p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  {s.status !== "revoked" && s.status !== "expired" && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void act(() => revokeShare(s.id), "Share revoked")}
                      data-testid={`share-revoke-${s.id}`}
                    >
                      Revoke
                    </Button>
                  )}
                  {(s.status === "revoked" || s.status === "expired") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void act(() => deleteShare(s.id), "Share deleted")}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
