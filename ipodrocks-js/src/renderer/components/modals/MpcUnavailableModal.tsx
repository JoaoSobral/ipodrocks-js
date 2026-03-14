import { useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";

interface MpcUnavailableModalProps {
  open: boolean;
  onClose: () => void;
  onDontRemind: () => void;
}

const MPC_INSTALL_HINT =
  "Musepack encoding requires the mpcenc encoder on your system PATH. " +
  "Install it from your package manager (e.g. musepack-tools on Debian/Ubuntu, musepack on macOS via Homebrew) " +
  "or from https://www.musepack.net/.";

export function MpcUnavailableModal({
  open,
  onClose,
  onDontRemind,
}: MpcUnavailableModalProps) {
  const [dontRemind, setDontRemind] = useState(false);

  const handleOk = () => {
    if (dontRemind) onDontRemind();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Musepack (MPC) unavailable">
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          Musepack encoding is not available because <code className="rounded bg-muted px-1">mpcenc</code> was not
          found on your system.
        </p>
        <p className="text-xs text-muted-foreground">
          {MPC_INSTALL_HINT}
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={dontRemind}
            onChange={(e) => setDontRemind(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/50 accent-primary"
          />
          <span className="text-sm text-muted-foreground">
            Do not remind me again
          </span>
        </label>
        <div className="flex justify-end pt-2">
          <Button onClick={handleOk}>OK</Button>
        </div>
      </div>
    </Modal>
  );
}
