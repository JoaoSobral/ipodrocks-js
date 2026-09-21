import { useEffect, useState } from "react";
import { Button } from "../common/Button";
import {
  getDeviceClient,
  supportsDirectoryPicker,
  type DeviceAttachState,
} from "../../device";

/**
 * The connect/disconnect control for a device plugged into *this* browser.
 *
 * Only rendered for a device whose `transport` is `web`. Everything about it is
 * shaped by three facts of the File System Access API:
 *
 * - `showDirectoryPicker()` needs a user gesture, so connecting is a button
 *   and never something the app does on mount.
 * - Permission does not survive a tab close, so a remembered folder still
 *   needs re-granting — also a gesture, hence "Reconnect" rather than a silent
 *   retry.
 * - The API does not exist in Firefox or Safari, or on iOS at all. That has to
 *   be said plainly here rather than discovered as a `TypeError` at the picker.
 */
export function WebDeviceLink({ deviceId }: { deviceId: number }) {
  const client = getDeviceClient();
  const [state, setState] = useState<DeviceAttachState>(
    () => client?.stateOf(deviceId) ?? { status: "detached" }
  );

  useEffect(() => {
    if (!client) return;
    setState(client.stateOf(deviceId));
    return client.onStateChange((id, next) => {
      if (id === deviceId) setState(next);
    });
  }, [client, deviceId]);

  if (!supportsDirectoryPicker()) {
    return (
      <p className="text-xs text-amber-600 dark:text-amber-500">
        This browser cannot open a device folder. Connecting a player needs the
        File System Access API — Chrome, Edge or another Chromium browser on a
        desktop.
      </p>
    );
  }

  if (!client) return null;

  const connected = state.status === "attached";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant={connected ? "ghost" : "primary"}
          onClick={() => {
            if (connected) void client.disconnect(deviceId);
            // Straight from the click: Chrome refuses a picker that is not
            // inside a user gesture, and the refusal looks exactly like the
            // user cancelling.
            else void client.pickAndAttach(deviceId);
          }}
        >
          {connected ? "Disconnect" : "Connect this device"}
        </Button>
        {state.status === "attaching" && (
          <span className="text-xs text-muted-foreground">Connecting…</span>
        )}
        {connected && (
          <span className="text-xs text-muted-foreground truncate">
            {state.rootName}
            {state.writable ? "" : " (read-only)"}
          </span>
        )}
      </div>

      {state.status === "error" && (
        <p className="text-xs text-blue-500">{state.message}</p>
      )}

      {connected && !state.writable && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          This folder was opened read-only, so nothing can be written to the
          player. Disconnect and connect it again, granting write access.
        </p>
      )}

      {connected && <ThroughputNote />}
    </div>
  );
}

/**
 * The thing a remote user has to understand before starting a sync.
 *
 * Every byte goes server → browser → device, over whatever link the user is on.
 * A FLAC library is simply impractical that way, and finding that out after
 * waiting three hours is a far worse experience than reading one sentence
 * first.
 */
function ThroughputNote() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      Files travel from the server to this browser and then onto the device, so
      a sync is limited by your connection to the server. For a large library,
      sync a <strong>shadow library</strong> or a partial selection rather than
      the whole thing.
    </p>
  );
}
