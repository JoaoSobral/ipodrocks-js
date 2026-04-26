import { describe, it, expect, vi } from "vitest";

vi.mock("@assets/device_icons/ipod_classic.png?url", () => ({ default: "classic.png" }));
vi.mock("@assets/device_icons/ipod_nano.png?url", () => ({ default: "nano.png" }));
vi.mock("@assets/device_icons/ipod_mini.png?url", () => ({ default: "mini.png" }));
vi.mock("@assets/device_icons/rockbox_gen1.png?url", () => ({ default: "gen1.png" }));
vi.mock("@assets/device_icons/rockbox_gen2.png?url", () => ({ default: "gen2.png" }));
vi.mock("@assets/device_icons/rockbox_gen3.png?url", () => ({ default: "gen3.png" }));
vi.mock("@assets/device_icons/rockbox_gen4.png?url", () => ({ default: "gen4.png" }));
vi.mock("@assets/device_icons/rockbox_gen5.png?url", () => ({ default: "gen5.png" }));
vi.mock("@assets/device_icons/rockbox_gen6.png?url", () => ({ default: "gen6.png" }));

import { getDeviceIconSrc, type DeviceIconInput } from "../renderer/utils/device-icon";

function dev(id: number, modelInternalValue: string | null, modelName: string | null = null): DeviceIconInput {
  return { id, modelInternalValue, modelName };
}

describe("getDeviceIconSrc - specific iPods", () => {
  it("returns the classic icon for iPod Classic", () => {
    const d = dev(1, "ipod_classic", "iPod Classic");
    expect(getDeviceIconSrc(d, [d])).toBe("classic.png");
  });

  it("returns the nano icon for iPod Nano (any generation)", () => {
    const d1 = dev(1, "ipod_nano", "iPod Nano 1-2 generation");
    const d2 = dev(2, "ipod_nano_3g", "iPod Nano 3rd generation");
    expect(getDeviceIconSrc(d1, [d1, d2])).toBe("nano.png");
    expect(getDeviceIconSrc(d2, [d1, d2])).toBe("nano.png");
  });

  it("returns the mini icon for iPod Mini", () => {
    const d = dev(1, "ipod_mini", "iPod Mini");
    expect(getDeviceIconSrc(d, [d])).toBe("mini.png");
  });

  it("matches by modelName when modelInternalValue is null", () => {
    const d = dev(1, null, "iPod Classic");
    expect(getDeviceIconSrc(d, [d])).toBe("classic.png");
  });
});

describe("getDeviceIconSrc - generic rockbox devices", () => {
  it("returns a rockbox_gen icon for non-iPod devices", () => {
    const d = dev(10, "fiio_m3k", "FiiO M3K");
    expect(getDeviceIconSrc(d, [d])).toMatch(/^gen[1-6]\.png$/);
  });

  it("assigns distinct rockbox_gen icons to the first 6 generic devices", () => {
    const devices: DeviceIconInput[] = [
      dev(1, "fiio_m3k"),
      dev(2, "aigo_eros_q"),
      dev(3, "aigo_eros_k"),
      dev(4, "agptek_h3"),
      dev(5, "hifi_walker_h2"),
      dev(6, "surfans_f20"),
    ];
    const icons = devices.map((d) => getDeviceIconSrc(d, devices));
    expect(new Set(icons).size).toBe(6);
    for (const icon of icons) {
      expect(icon).toMatch(/^gen[1-6]\.png$/);
    }
  });

  it("cycles after 6: the 7th generic device repeats one of the existing icons", () => {
    const devices: DeviceIconInput[] = Array.from({ length: 7 }, (_, i) =>
      dev(i + 1, "fiio_m3k"),
    );
    const icons = devices.map((d) => getDeviceIconSrc(d, devices));
    expect(new Set(icons).size).toBe(6);
    expect(icons[6]).toBe(icons[0]);
  });

  it("ignores specific iPods when computing generic positions", () => {
    const classic = dev(1, "ipod_classic");
    const nano = dev(2, "ipod_nano");
    const generic1 = dev(3, "fiio_m3k");
    const generic2 = dev(4, "agptek_h3");
    const list = [classic, nano, generic1, generic2];
    expect(getDeviceIconSrc(classic, list)).toBe("classic.png");
    expect(getDeviceIconSrc(nano, list)).toBe("nano.png");
    const g1 = getDeviceIconSrc(generic1, list);
    const g2 = getDeviceIconSrc(generic2, list);
    expect(g1).toMatch(/^gen[1-6]\.png$/);
    expect(g2).toMatch(/^gen[1-6]\.png$/);
    expect(g1).not.toBe(g2);
  });

  it("is stable when a new generic device is added later (existing assignments do not change)", () => {
    const a = dev(1, "fiio_m3k");
    const b = dev(2, "aigo_eros_q");
    const beforeA = getDeviceIconSrc(a, [a]);
    const after = [a, b];
    expect(getDeviceIconSrc(a, after)).toBe(beforeA);
    expect(getDeviceIconSrc(b, after)).not.toBe(beforeA);
  });

  it("orders generic devices by id (creation order) regardless of input order", () => {
    const a = dev(1, "fiio_m3k");
    const b = dev(2, "aigo_eros_q");
    const inOrder = [a, b];
    const reversed = [b, a];
    expect(getDeviceIconSrc(a, inOrder)).toBe(getDeviceIconSrc(a, reversed));
    expect(getDeviceIconSrc(b, inOrder)).toBe(getDeviceIconSrc(b, reversed));
  });

  it("falls back to a generic icon when modelInternalValue and modelName are both null", () => {
    const d = dev(1, null, null);
    expect(getDeviceIconSrc(d, [d])).toMatch(/^gen[1-6]\.png$/);
  });
});
