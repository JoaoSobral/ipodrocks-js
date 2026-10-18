import type { UsbDeviceInfo } from "@shared/types";

/**
 * A USB identity flattened into one string so it can live in a <Select> value.
 * Empty means "no identity — match by mount path".
 */
export function usbKeyOf(
  vendorId?: string | null,
  productId?: string | null,
  serial?: string | null
): string {
  if (!vendorId || !productId) return "";
  return `${vendorId}:${productId}:${serial ?? ""}`;
}

/** Split a key back into the three columns. A blank key clears the identity. */
export function parseUsbKey(key: string): {
  usbVendorId: string | null;
  usbProductId: string | null;
  usbSerial: string | null;
} {
  if (!key) return { usbVendorId: null, usbProductId: null, usbSerial: null };
  const [vendorId, productId, ...rest] = key.split(":");
  return { usbVendorId: vendorId, usbProductId: productId, usbSerial: rest.join(":") };
}

/** Best-effort display name; many devices report no product string at all. */
export function usbLabel(device: UsbDeviceInfo): string {
  const base = device.ipodModel || device.productName || device.vendorName || "Unknown device";
  return device.serial ? base : `${base} (no serial)`;
}
