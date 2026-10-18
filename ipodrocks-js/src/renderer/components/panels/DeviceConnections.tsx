import { useEffect, useMemo, useState, type JSX } from "react";
import { toast } from "sonner";
import type { DeviceProfile, UsbDeviceInfo } from "@shared/types";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import { Modal } from "../common/Modal";
import { Select, type SelectOption } from "../common/Select";
import { listUsbDevices, pickFolder, setDeviceConnections } from "../../ipc/api";
import { isWebMode } from "../../ipc/web-transport";
import { parseUsbKey, usbKeyOf, usbLabel } from "../../utils/usb-identity";

/**
 * How a device connects, and the controls to change it.
 *
 * A device is local (plugged into the machine running iPodRocks), remote (a
 * folder held in a browser) or hybrid (both: the desktop app syncs it through
 * its mount, a browser through its folder). A hybrid device must have a USB
 * identity, so its local side is always the actual player.
 *
 * - Desktop app: let a browser use a local device (needs its USB device set),
 *   stop that again, or give a remote device a local side (mount path + USB).
 * - Browser (the server's owner only — the server says so if not): start or
 *   stop using a server-attached device from this browser. The folder itself
 *   is then connected with the card's usual "Connect folder" control.
 */
export function DeviceConnections({
  device,
  onChanged,
}: {
  device: DeviceProfile;
  onChanged: () => void;
}) {
  const web = isWebMode();
  const [busy, setBusy] = useState(false);
  const [addLocal, setAddLocal] = useState(false);
  const connection = device.connection ?? (device.transport === "web" ? "remote" : "local");
  const hasUsb = Boolean(device.usbVendorId && device.usbProductId);

  const apply = async (change: Parameters<typeof setDeviceConnections>[1], done: string) => {
    setBusy(true);
    try {
      const res = await setDeviceConnections(device.id, change);
      if (res && "error" in res) {
        toast.error(res.error);
        return false;
      }
      toast.success(done);
      onChanged();
      return true;
    } finally {
      setBusy(false);
    }
  };

  let control: JSX.Element | null = null;
  if (web) {
    if (connection === "local") {
      control = (
        <span title={hasUsb ? undefined : "Set this device's USB device in the desktop app first."}>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !hasUsb}
            data-testid="device-allow-browser"
            onClick={() => void apply({ remote: true }, `${device.name} can now be used from this browser — connect its folder.`)}
          >
            Use from this browser
          </Button>
        </span>
      );
    } else if (connection === "hybrid") {
      control = (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid="device-stop-browser"
          onClick={() => void apply({ remote: false }, `${device.name} is no longer used from a browser.`)}
        >
          Stop using from browsers
        </Button>
      );
    }
  } else if (connection === "local") {
    control = (
      <span title={hasUsb ? undefined : "Set the USB device in Edit first, so the local side is always the actual player."}>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !hasUsb}
          data-testid="device-allow-browser"
          onClick={() => void apply({ remote: true }, `${device.name} can now also be used from a browser.`)}
        >
          Also allow browser use
        </Button>
      </span>
    );
  } else if (connection === "hybrid") {
    control = (
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        data-testid="device-stop-browser"
        onClick={() => void apply({ remote: false }, `${device.name} is now local only.`)}
      >
        Stop browser use
      </Button>
    );
  } else {
    control = (
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        data-testid="device-add-local"
        onClick={() => setAddLocal(true)}
      >
        Add local connection
      </Button>
    );
  }

  const label =
    connection === "hybrid"
      ? web
        ? "Hybrid — this browser uses its folder; the server uses its USB mount."
        : "Hybrid — synced here through its USB mount, and from a browser through its folder."
      : connection === "remote"
        ? "Remote — held by a browser."
        : "Local — plugged into this machine.";

  return (
    <div className="mb-4 rounded-lg border border-border p-2 text-xs" data-testid="device-connections">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        {control}
      </div>
      {addLocal && (
        <AddLocalConnectionModal
          device={device}
          onClose={() => setAddLocal(false)}
          onSave={async (local) => {
            const ok = await apply(
              { local, remote: true },
              `${device.name} is now hybrid: synced here and from its browser.`
            );
            if (ok) setAddLocal(false);
          }}
        />
      )}
    </div>
  );
}

function AddLocalConnectionModal({
  device,
  onClose,
  onSave,
}: {
  device: DeviceProfile;
  onClose: () => void;
  onSave: (local: {
    mountPath: string;
    usbVendorId: string | null;
    usbProductId: string | null;
    usbSerial: string | null;
  }) => Promise<void>;
}) {
  const [mountPath, setMountPath] = useState("");
  const [usbKey, setUsbKey] = useState(
    usbKeyOf(device.usbVendorId, device.usbProductId, device.usbSerial)
  );
  const [usbDevices, setUsbDevices] = useState<UsbDeviceInfo[]>([]);

  useEffect(() => {
    void listUsbDevices().then((r) => {
      if (r && !("error" in r)) setUsbDevices(r.devices);
    });
  }, []);

  const options = useMemo(() => {
    const opts: SelectOption[] = [{ value: "", label: "Choose the player's USB device" }];
    for (const d of usbDevices) {
      opts.push({
        value: usbKeyOf(d.vendorId, d.productId, d.serial),
        label: usbLabel(d),
        detail: `${d.vendorId}:${d.productId}`,
      });
    }
    if (usbKey && !opts.some((o) => o.value === usbKey)) {
      opts.push({ value: usbKey, label: "Saved device — not connected" });
    }
    return opts;
  }, [usbDevices, usbKey]);

  const ready = mountPath.trim() !== "" && usbKey !== "";
  return (
    <Modal open onClose={onClose} title={`Add a local connection to ${device.name}`}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Plug the player into this machine. It stays usable from its browser too; this app
          syncs it through the mount path, matched by its USB device.
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Input
              label="Mount Path"
              value={mountPath}
              onChange={(e) => setMountPath(e.target.value)}
              placeholder="/run/media/you/IPOD"
              data-testid="hybrid-mount-path"
            />
          </div>
          <Button
            size="md"
            onClick={async () => {
              const picked = await pickFolder();
              if (picked) setMountPath(picked);
            }}
          >
            Browse
          </Button>
        </div>
        <Select
          label="USB Device"
          options={options}
          value={usbKey}
          onChange={setUsbKey}
          placeholder="Choose the player's USB device"
          testId="hybrid-usb-select"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => void onSave({ mountPath: mountPath.trim(), ...parseUsbKey(usbKey) })}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
