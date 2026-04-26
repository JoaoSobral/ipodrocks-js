import ipodClassicIcon from "@assets/device_icons/ipod_classic.png?url";
import ipodNanoIcon from "@assets/device_icons/ipod_nano.png?url";
import ipodMiniIcon from "@assets/device_icons/ipod_mini.png?url";
import rockboxGen1 from "@assets/device_icons/rockbox_gen1.png?url";
import rockboxGen2 from "@assets/device_icons/rockbox_gen2.png?url";
import rockboxGen3 from "@assets/device_icons/rockbox_gen3.png?url";
import rockboxGen4 from "@assets/device_icons/rockbox_gen4.png?url";
import rockboxGen5 from "@assets/device_icons/rockbox_gen5.png?url";
import rockboxGen6 from "@assets/device_icons/rockbox_gen6.png?url";

const ROCKBOX_GENS = [
  rockboxGen1,
  rockboxGen2,
  rockboxGen3,
  rockboxGen4,
  rockboxGen5,
  rockboxGen6,
];

// Fixed permutation of [0..5]: gives the first 6 generic devices distinct
// rockbox_gen icons in a non-sequential order; the 7th onward cycles.
const GEN_SHUFFLE = [2, 0, 4, 1, 5, 3];

export type DeviceIconInput = {
  id: number;
  modelInternalValue?: string | null;
  modelName?: string | null;
};

type SpecificIpod = "classic" | "nano" | "mini";

const SPECIFIC_ICONS: Record<SpecificIpod, string> = {
  classic: ipodClassicIcon,
  nano: ipodNanoIcon,
  mini: ipodMiniIcon,
};

function classifySpecific(device: DeviceIconInput): SpecificIpod | null {
  const internal = (device.modelInternalValue ?? "").toLowerCase();
  const name = (device.modelName ?? "").toLowerCase();
  if (internal.includes("classic") || name.includes("classic")) return "classic";
  if (internal.includes("nano") || name.includes("nano")) return "nano";
  if (internal.includes("mini") || name.includes("mini")) return "mini";
  return null;
}

export type DeviceIconResolver = (device: DeviceIconInput) => string;

export function createDeviceIconResolver(
  allDevices: readonly DeviceIconInput[],
): DeviceIconResolver {
  const genericSlot = new Map<number, number>();
  const genericIds = allDevices
    .filter((d) => classifySpecific(d) === null)
    .map((d) => d.id)
    .sort((a, b) => a - b);
  genericIds.forEach((id, i) => genericSlot.set(id, i));

  return (device) => {
    const specific = classifySpecific(device);
    if (specific) return SPECIFIC_ICONS[specific];
    const slot = genericSlot.get(device.id) ?? 0;
    return ROCKBOX_GENS[GEN_SHUFFLE[slot % GEN_SHUFFLE.length]];
  };
}

export function getDeviceIconSrc(
  device: DeviceIconInput,
  allDevices: readonly DeviceIconInput[],
): string {
  return createDeviceIconResolver(allDevices)(device);
}
