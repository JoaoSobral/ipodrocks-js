import { useState } from "react";
import { Button, Input } from "../common";
import { ErrorBox } from "../common/ErrorBox";
import { TrackPicker } from "./TrackPicker";
import { createClassicPlaylist, updateClassicPlaylist } from "../../ipc/api";
import type { Playlist, Track } from "../../ipc/api";
import { CLASSIC_PLAYLIST_MAX_TRACKS } from "@shared/types";

interface ClassicPlaylistFormProps {
  /** Music tracks to pick from. */
  tracks: Track[];
  tracksLoading?: boolean;
  /** Playlist id when editing an existing Classic playlist; null when creating. */
  editingId: number | null;
  /** Pre-filled name (already stripped of the classic_ prefix). */
  initialName: string;
  /** Pre-ticked track ids, in playlist order. */
  initialSelectedIds: number[];
  onSaved: (playlist: Playlist) => void;
  onCancel: () => void;
}

/**
 * Create-or-edit form for a Classic playlist: a name plus a hand-picked,
 * ordered track selection. Both modes share the same picker so an edit shows
 * exactly the UI the playlist was built with.
 */
export function ClassicPlaylistForm({
  tracks,
  tracksLoading = false,
  editingId,
  initialName,
  initialSelectedIds,
  onSaved,
  onCancel,
}: ClassicPlaylistFormProps) {
  const [name, setName] = useState(initialName);
  const [selectedIds, setSelectedIds] = useState<number[]>(initialSelectedIds);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = editingId !== null;
  const trimmedName = name.trim();
  const canSave = !!trimmedName && selectedIds.length > 0 && !saving;

  async function handleSave() {
    setSubmitted(true);
    if (!trimmedName || selectedIds.length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const playlist = isEditing
        ? await updateClassicPlaylist({
            playlistId: editingId,
            name: trimmedName,
            trackIds: selectedIds,
          })
        : await createClassicPlaylist({ name: trimmedName, trackIds: selectedIds });
      onSaved(playlist);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="My Mixtape"
        hint={submitted && !trimmedName ? "Please enter a playlist name" : undefined}
        data-testid="classic-name-input"
      />

      <p className="text-[11px] text-muted-foreground">
        Pick the songs you want, in the order you want them. Your selection is
        kept as you search and filter, so you can build the list from several
        passes.
      </p>

      <div className="min-h-[300px] flex flex-col">
        <TrackPicker
          tracks={tracks}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          maxSelection={CLASSIC_PLAYLIST_MAX_TRACKS}
          loading={tracksLoading}
        />
      </div>

      {submitted && selectedIds.length === 0 && (
        <p className="text-xs text-destructive">Pick at least one song.</p>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={!canSave}
          data-testid="classic-save"
        >
          {saving
            ? "Saving…"
            : isEditing
              ? `Save changes (${selectedIds.length})`
              : `Create playlist (${selectedIds.length})`}
        </Button>
      </div>
    </div>
  );
}
