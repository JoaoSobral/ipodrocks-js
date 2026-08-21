/**
 * Apple iPod USB product ids.
 *
 * Used to label and prioritize iPods in the device-identity dropdown. This
 * matters beyond cosmetics: a device in DFU or WTF (recovery) mode does not
 * expose a USB mass-storage interface, so storage-class grouping alone would
 * bury it at the bottom of the list next to keyboards and hubs.
 *
 * Source: Apple USB vendor id 0x05ac.
 */

export const APPLE_USB_VENDOR_ID = "05ac";

/** Product id (lowercase hex) → human-readable model. */
export const IPOD_PRODUCT_NAMES: Record<string, string> = {
  "1201": "iPod with dock connector (3rd generation)",
  "1202": "iPod (1st/2nd generation)",
  "1203": "iPod with Click Wheel (4th generation)",
  "1204": "iPod Photo / iPod with color display",
  "1205": "iPod mini",
  "1209": "iPod with video (5th generation)",
  "120a": "iPod nano",
  "1260": "iPod nano (2nd generation)",
  "1261": "iPod classic (6th generation)",
  "1262": "iPod nano (3rd generation)",
  "1263": "iPod nano (4th generation)",
  "1265": "iPod nano (5th generation)",
  "1266": "iPod nano (6th generation)",
  "1267": "iPod nano (7th generation)",

  // Recovery modes. These cannot be synced to, but naming them explains why a
  // device the user can see is not usable yet.
  "1220": "iPod nano (2nd generation) — DFU mode",
  "1221": "iPod shuffle (2nd generation) — DFU mode",
  "1222": "Apple device — DFU mode (Diags)",
  "1223": "iPod classic (6th gen) / nano (3rd gen) — DFU mode",
  "1225": "iPod nano (4th generation) — DFU mode",
  "1227": "Apple device — DFU mode",
  "1231": "iPod nano (5th generation) — DFU mode",
  "1232": "iPod nano (6th generation) — DFU mode",
  "1234": "iPod nano (7th generation) — DFU mode",
  "1240": "iPod nano (2nd generation) — WTF mode",
  "1241": "iPod classic (6th generation, Late 2007) — WTF mode",
  "1242": "iPod nano (3rd generation) — WTF mode",
  "1243": "iPod nano (4th generation) — WTF mode",
  "1245": "iPod classic (6th generation, Late 2008) — WTF mode",
  "1246": "iPod nano (5th generation) — WTF mode",
  "1247": "iPod classic (6th generation, Late 2009) — WTF mode",
  "1248": "iPod nano (6th generation) — WTF mode",
  "1249": "iPod nano (7th generation, Late 2012) — WTF mode",
  "124a": "iPod nano (7th generation, Mid 2015) — WTF mode",
  "1250": "iPod classic (6th generation, Late 2012) — WTF mode",
};

/**
 * Recognize a connected USB device as a known iPod model.
 * Returns null for anything that is not an Apple iPod.
 */
export function identifyIpodModel(vendorId: string, productId: string): string | null {
  if (vendorId.toLowerCase() !== APPLE_USB_VENDOR_ID) return null;
  return IPOD_PRODUCT_NAMES[productId.toLowerCase()] ?? null;
}
