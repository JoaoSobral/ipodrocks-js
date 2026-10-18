import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import {
  getLibraryPrefs,
  getScanReminder,
  snoozeScanReminder,
} from "../../ipc/api";
import { isWebMode } from "../../ipc/web-transport";
import { useUIStore } from "../../stores/ui-store";

/** Once per app load — not per remount of App. */
let startupCheckDone = false;

function formatLastScan(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function scanReminderQuestion(lastScanAt: string | null): string {
  return lastScanAt
    ? `You haven't scanned your library since ${formatLastScan(lastScanAt)}.`
    : "Your library has not been scanned yet.";
}

/**
 * Keeps the library current on startup.
 *
 * With Settings → Library → "Scan library at startup" on, the desktop app
 * starts a scan as soon as it opens (the daemon does its own at boot, so a
 * browser never starts one just by loading). With it off, the owner is asked
 * once the library is 10 days stale: a modal on the desktop, a toast in the
 * browser so it never sits in front of somebody's work. "No" snoozes it for
 * another 10 days; the server decides all of that, and only for the owner.
 */
export function ScanReminder() {
  const setPendingLibraryScan = useUIStore((s) => s.setPendingLibraryScan);
  const [modal, setModal] = useState<{ lastScanAt: string | null } | null>(null);

  useEffect(() => {
    if (startupCheckDone) return;
    startupCheckDone = true;
    const web = isWebMode();
    void (async () => {
      try {
        if (!web) {
          const prefs = await getLibraryPrefs();
          if (prefs?.scanOnStartup) {
            setPendingLibraryScan(true);
            return;
          }
        }
        const reminder = await getScanReminder();
        if (!reminder?.due) return;
        if (!web) {
          setModal({ lastScanAt: reminder.lastScanAt });
          return;
        }
        toast(scanReminderQuestion(reminder.lastScanAt), {
          id: "scan-reminder",
          description: "Do you wish to scan it now?",
          duration: Infinity,
          action: { label: "Scan now", onClick: () => setPendingLibraryScan(true) },
          cancel: { label: "Not now", onClick: () => void snoozeScanReminder() },
        });
      } catch {
        /* a reminder is never worth an error on startup */
      }
    })();
  }, [setPendingLibraryScan]);

  if (!modal) return null;
  const close = () => setModal(null);
  return (
    <Modal open onClose={close} title="Scan your library?">
      <div className="space-y-4" data-testid="scan-reminder">
        <p className="text-sm text-foreground">{scanReminderQuestion(modal.lastScanAt)}</p>
        <p className="text-sm text-muted-foreground">Do you wish to scan it now?</p>
        <p className="text-xs text-muted-foreground">
          Turn on Settings → Library → Scan library at startup to keep it current automatically.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            onClick={() => {
              void snoozeScanReminder();
              close();
            }}
          >
            No
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              setPendingLibraryScan(true);
            }}
          >
            Yes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
