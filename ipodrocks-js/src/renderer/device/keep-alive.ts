import { useEffect } from "react";

/**
 * Keeps a tab that is carrying a sync from being frozen, discarded or closed
 * by accident.
 *
 * In web mode the browser *is* the device's filesystem: every byte of a sync
 * goes through this tab. Chrome freezes background tabs to save power and
 * discards them under memory pressure, and either one ends the sync as surely
 * as unplugging the player. Three levers, each feature-detected and each
 * allowed to fail quietly:
 *
 * - **A Web Lock.** Chrome does not freeze or discard a tab holding one.
 * - **A screen Wake Lock**, so the machine does not sleep under a long sync.
 *   The browser drops it whenever the tab is hidden, so it is re-requested
 *   when the tab becomes visible again.
 * - **`beforeunload`**, so closing the tab asks first.
 */
export function useKeepTabAlive(active: boolean, label: string): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    let released = false;
    let releaseLock: (() => void) | null = null;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (locks?.request) {
      void locks
        .request(`ipodrocks-${label}`, () =>
          new Promise<void>((resolve) => {
            releaseLock = resolve;
            if (released) resolve();
          })
        )
        .catch(() => {});
    }

    type WakeLockSentinelLike = { release(): Promise<void> };
    let wakeLock: WakeLockSentinelLike | null = null;
    const wake = (navigator as Navigator & {
      wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
    }).wakeLock;
    const requestWake = () => {
      if (!wake || released || document.visibilityState !== "visible") return;
      wake
        .request("screen")
        .then((sentinel) => {
          if (released) void sentinel.release().catch(() => {});
          else wakeLock = sentinel;
        })
        .catch(() => {});
    };
    requestWake();
    const onVisible = () => {
      if (document.visibilityState === "visible") requestWake();
    };
    document.addEventListener("visibilitychange", onVisible);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers need a value set to show the prompt at all.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      released = true;
      releaseLock?.();
      void wakeLock?.release().catch(() => {});
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active, label]);
}
