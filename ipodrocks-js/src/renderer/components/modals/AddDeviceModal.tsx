import { useState } from "react";
import type { DeviceProfile } from "@shared/types";
import { addDevice } from "@renderer/ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { ErrorBox } from "../common/ErrorBox";

interface AddDeviceModalProps {
  open: boolean;
  onClose: (result?: DeviceProfile) => void;
}

export function AddDeviceModal({ open, onClose }: AddDeviceModalProps) {
  const [name, setName] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [musicFolder, setMusicFolder] = useState("Music");
  const [podcastFolder, setPodcastFolder] = useState("Podcasts");
  const [audiobookFolder, setAudiobookFolder] = useState("Audiobooks");
  const [playlistFolder, setPlaylistFolder] = useState("Playlists");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() !== "" && mountPath.trim() !== "" && !loading;

  const reset = () => {
    setName("");
    setMountPath("");
    setMusicFolder("Music");
    setPodcastFolder("Podcasts");
    setAudiobookFolder("Audiobooks");
    setPlaylistFolder("Playlists");
    setError(null);
    setLoading(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      const device = await addDevice({
        name: name.trim(),
        mountPath: mountPath.trim(),
        musicFolder: musicFolder.trim() || "Music",
        podcastFolder: podcastFolder.trim() || "Podcasts",
        audiobookFolder: audiobookFolder.trim() || "Audiobooks",
        playlistFolder: playlistFolder.trim() || "Playlists",
      });
      reset();
      onClose(device);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Add Device">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <Input
          label="Device Name"
          placeholder="e.g. iPod Classic"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Input
          label="Mount Path"
          placeholder="/media/ipod"
          value={mountPath}
          onChange={(e) => setMountPath(e.target.value)}
        />

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

        {error && (
          <ErrorBox>{error}</ErrorBox>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {loading ? "Adding…" : "Add Device"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
