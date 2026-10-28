import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import type { ExtraTrackPolicy } from "@shared/types";

/**
 * How long the confirm button stays disabled. Long enough that a reflexive
 * Enter or double-click on Start Sync cannot carry straight through a warning
 * about deleting things off the player.
 */
export const ORPHAN_GATE_DELAY_MS = 2000;

type GatedPolicy = Exclude<ExtraTrackPolicy, "keep">;

interface GateCopy {
  title: string;
  lead: (device: string) => ReactNode;
  points: string[];
  confirm: string;
  danger: boolean;
  /** Whether "do not show this warning again" is offered. Never for Delete all. */
  dismissible: boolean;
}

const COPY: Record<GatedPolicy, GateCopy> = {
  remove: {
    title: "Remove what is not in this sync?",
    lead: (device) => (
      <>
        <strong>Remove orphans</strong> makes <strong>{device}</strong> match the
        library being synced. Any <strong>music</strong>, <strong>podcasts</strong>{" "}
        or <strong>audiobooks</strong> on the device that are not part of this
        sync will be <strong>deleted from the device</strong>.
      </>
    ),
    points: [
      "This includes files you copied to the device yourself, outside iPodRocks.",
      "It covers every content type, even ones this sync has nothing to copy.",
      "Files that already match the library stay where they are.",
      "Ratings and listening history stored on the device are not touched.",
    ],
    confirm: "Remove and sync",
    danger: true,
    dismissible: true,
  },
  "delete-all": {
    title: "Erase and rebuild this device?",
    lead: (device) => (
      <>
        This deletes the <strong>Music</strong>, <strong>Podcasts</strong> and{" "}
        <strong>Audiobooks</strong> folders on <strong>{device}</strong> and
        rebuilds them from your library.
      </>
    ),
    points: [
      "Everything currently in those folders is removed, including files iPodRocks did not put there.",
      "Auto-podcast episodes are downloaded again, so this can take a while.",
      "Ratings and listening history stored on the device are not touched.",
    ],
    confirm: "Erase and rebuild",
    danger: true,
    dismissible: false,
  },
  prompt: {
    title: "Report what does not match?",
    lead: (device) => (
      <>
        With <strong>Prompt</strong>, nothing is deleted. The sync copies what is
        missing and reports the <strong>music</strong>, <strong>podcasts</strong>{" "}
        and <strong>audiobooks</strong> on <strong>{device}</strong> that do not
        match the library being synced.
      </>
    ),
    points: [
      "To delete those files, sync again with Remove orphans.",
      "Choose Keep to skip this question next time.",
    ],
    confirm: "Sync",
    danger: false,
    dismissible: true,
  },
};

interface OrphanPolicyGateProps {
  /** The policy to warn about; null closes the gate. */
  policy: ExtraTrackPolicy | null;
  deviceName: string;
  onCancel: () => void;
  /** `dontShowAgain` is the state of the per-device "do not show again" box. */
  onConfirm: (dontShowAgain: boolean) => void;
}

/**
 * The warning shown when Start Sync is pressed with any Orphan & Reset Policy
 * other than Keep. iPodRocks treats the library as the source of truth, so
 * those policies make the device follow it — the user should read that before
 * it happens, not in the sync log afterwards.
 */
export function OrphanPolicyGate({ policy, deviceName, onCancel, onConfirm }: OrphanPolicyGateProps) {
  const gated = policy && policy !== "keep" ? policy : null;
  const [remainingMs, setRemainingMs] = useState(ORPHAN_GATE_DELAY_MS);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Restart the countdown every time the gate opens.
  useEffect(() => {
    if (!gated) return;
    const started = Date.now();
    setRemainingMs(ORPHAN_GATE_DELAY_MS);
    setDontShowAgain(false);
    const timer = setInterval(() => {
      const left = Math.max(0, ORPHAN_GATE_DELAY_MS - (Date.now() - started));
      setRemainingMs(left);
      if (left === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [gated]);

  const copy = gated ? COPY[gated] : null;
  const waiting = remainingMs > 0;

  return (
    <Modal open={copy !== null} onClose={onCancel} title={copy?.title ?? ""} className="max-w-md">
      {copy && (
        <div className="flex flex-col gap-4" data-testid="orphan-policy-gate">
          <p className="text-sm text-foreground">{copy.lead(deviceName)}</p>
          <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-1">
            {copy.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {copy.dismissible && (
            <label className="flex items-center gap-2 cursor-default">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="accent-primary rounded"
                data-testid="orphan-policy-gate-dont-show"
              />
              <span className="text-xs text-muted-foreground">
                Do not show this warning again for this device
              </span>
            </label>
          )}
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant={copy.danger ? "danger" : "primary"}
              disabled={waiting}
              aria-label={copy.confirm}
              data-testid="orphan-policy-gate-confirm"
              onClick={() => onConfirm(copy.dismissible && dontShowAgain)}
            >
              {waiting ? `${copy.confirm} (${Math.ceil(remainingMs / 1000)})` : copy.confirm}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
