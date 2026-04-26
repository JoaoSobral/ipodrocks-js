import { useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { setUpdateSnooze, openExternal } from "../../ipc/api";

interface UpdateAvailableModalProps {
  open: boolean;
  onClose: () => void;
  current: string;
  latest: string;
  htmlUrl: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function UpdateAvailableModal({
  open,
  onClose,
  current,
  latest,
  htmlUrl,
}: UpdateAvailableModalProps) {
  const [snooze, setSnooze] = useState(false);

  const handleClose = async () => {
    if (snooze) await setUpdateSnooze(Date.now() + THIRTY_DAYS_MS);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Update available" closeOnBackdropClick>
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          Version <strong>{latest}</strong> is available. You are running{" "}
          <strong>{current}</strong>.
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={snooze}
            onChange={(e) => setSnooze(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/50 accent-primary"
          />
          <span className="text-sm text-muted-foreground">
            Don't check for updates for the next 30 days
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => openExternal(htmlUrl)}>
            Go to Releases
          </Button>
        </div>
      </div>
    </Modal>
  );
}
