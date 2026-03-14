import { useState } from "react";
import type { LibraryFolder } from "@shared/types";
import { addLibraryFolder } from "@renderer/ipc/api";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Select } from "../common/Select";
import { ErrorBox } from "../common/ErrorBox";

interface AddFolderModalProps {
  open: boolean;
  onClose: (result?: LibraryFolder) => void;
}

const contentTypeOptions = [
  { value: "music", label: "Music" },
  { value: "podcast", label: "Podcasts" },
  { value: "audiobook", label: "Audiobooks" },
];

export function AddFolderModal({ open, onClose }: AddFolderModalProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [contentType, setContentType] = useState("music");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameError = name.trim() === "" ? undefined : undefined;
  const pathError = path.trim() === "" ? undefined : undefined;
  const canSubmit = name.trim() !== "" && path.trim() !== "" && !loading;

  const reset = () => {
    setName("");
    setPath("");
    setContentType("music");
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
      const folder = await addLibraryFolder(name.trim(), path.trim(), contentType);
      reset();
      onClose(folder);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Add Library Folder">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <Input
          label="Folder Name"
          placeholder="e.g. Main Music"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          autoFocus
        />
        <Input
          label="Folder Path"
          placeholder="/path/to/music"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          error={pathError}
        />
        <Select
          label="Content Type"
          options={contentTypeOptions}
          value={contentType}
          onChange={(v) => setContentType(v)}
        />

        <p className="text-xs text-muted-foreground">
          Supported formats: MP3, M4A, FLAC, WAV, AIFF, OGG, Opus
        </p>

        {error && (
          <ErrorBox>{error}</ErrorBox>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {loading ? "Adding…" : "Add Folder"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
