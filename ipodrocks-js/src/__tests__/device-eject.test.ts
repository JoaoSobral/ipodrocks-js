/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  buildEjectCommand,
  isEjectSupported,
  resolveBlockDevice,
  unescapeMountField,
  EjectUnsupportedError,
} from "../main/devices/device-eject";
import { ejectDisabledReason } from "../renderer/ipc/api";

/**
 * Trimmed from real /proc/mounts on a Linux desktop with a USB player plugged
 * in. Formatting is preserved verbatim, including the `\040` the kernel writes
 * for the space in "My iPod".
 */
const PROC_MOUNTS_FIXTURE = [
  "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
  "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
  "/dev/nvme0n1p2 / ext4 rw,relatime 0 0",
  "/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0",
  "/dev/sdb1 /media/pedro/My\\040iPod vfat rw,nosuid,nodev,relatime,uid=1000 0 0",
  "tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime,size=1636920k 0 0",
  "",
].join("\n");

describe("buildEjectCommand", () => {
  it("uses diskutil eject on macOS", () => {
    expect(buildEjectCommand("/Volumes/IPOD", null, "darwin")).toEqual({
      command: "diskutil",
      args: ["eject", "/Volumes/IPOD"],
    });
  });

  it("addresses the block device via udisksctl on Linux", () => {
    expect(buildEjectCommand("/media/pedro/IPOD", "/dev/sdb1", "linux")).toEqual({
      command: "udisksctl",
      args: ["unmount", "-b", "/dev/sdb1"],
    });
  });

  it("falls back to umount on Linux when the block device is unknown", () => {
    expect(buildEjectCommand("/media/pedro/IPOD", null, "linux")).toEqual({
      command: "umount",
      args: ["/media/pedro/IPOD"],
    });
  });

  it("refuses on Windows rather than shipping an unreliable command", () => {
    expect(() => buildEjectCommand("E:\\", null, "win32")).toThrow(EjectUnsupportedError);
    expect(isEjectSupported("win32")).toBe(false);
    expect(isEjectSupported("darwin")).toBe(true);
    expect(isEjectSupported("linux")).toBe(true);
  });

  /**
   * The command is spawned through execFile with no shell. Pinning that the
   * path arrives as one unmodified argv entry is what proves a volume name can
   * never be interpreted as shell syntax.
   */
  it("passes a hostile mount path through as a single verbatim argument", () => {
    const nasty = `/Volumes/My iPod; rm -rf ~ $(whoami) "quoted" 'single'`;
    const cmd = buildEjectCommand(nasty, null, "darwin");
    expect(cmd.args).toEqual(["eject", nasty]);
    expect(cmd.args[1]).toBe(nasty);
    expect(cmd.args).toHaveLength(2);
  });
});

describe("unescapeMountField", () => {
  it("decodes the octal escapes the kernel writes", () => {
    expect(unescapeMountField("/media/pedro/My\\040iPod")).toBe("/media/pedro/My iPod");
    expect(unescapeMountField("/mnt/a\\011b")).toBe("/mnt/a\tb");
    expect(unescapeMountField("/mnt/a\\012b")).toBe("/mnt/a\nb");
    expect(unescapeMountField("/mnt/a\\134b")).toBe("/mnt/a\\b");
  });

  it("leaves an ordinary path alone", () => {
    expect(unescapeMountField("/media/pedro/IPOD")).toBe("/media/pedro/IPOD");
  });
});

describe("resolveBlockDevice", () => {
  it("finds the block device for a mount point", () => {
    expect(resolveBlockDevice("/", PROC_MOUNTS_FIXTURE)).toBe("/dev/nvme0n1p2");
    expect(resolveBlockDevice("/boot/efi", PROC_MOUNTS_FIXTURE)).toBe("/dev/nvme0n1p1");
  });

  it("matches a mount point whose name contains a space", () => {
    expect(resolveBlockDevice("/media/pedro/My iPod", PROC_MOUNTS_FIXTURE)).toBe("/dev/sdb1");
  });

  it("returns null for a path that is not a mount point", () => {
    expect(resolveBlockDevice("/home/pedro/Music", PROC_MOUNTS_FIXTURE)).toBeNull();
  });

  it("ignores mounts with no backing block device", () => {
    expect(resolveBlockDevice("/run/user/1000", PROC_MOUNTS_FIXTURE)).toBeNull();
    expect(resolveBlockDevice("/proc", PROC_MOUNTS_FIXTURE)).toBeNull();
  });

  it("prefers the last entry when a path is mounted over", () => {
    const shadowed = [
      "/dev/sdb1 /media/pedro/IPOD vfat rw 0 0",
      "/dev/sdc1 /media/pedro/IPOD vfat rw 0 0",
    ].join("\n");
    expect(resolveBlockDevice("/media/pedro/IPOD", shadowed)).toBe("/dev/sdc1");
  });
});

/**
 * The renderer's half of the same gate. It is a pure function of (platform,
 * online) precisely so the Windows branch is testable — the e2e spec skips
 * itself on win32, so this is the only cover the greyed-out-on-Windows state
 * gets.
 */
describe("ejectDisabledReason", () => {
  it("names Windows, and what to use there instead", () => {
    const reason = ejectDisabledReason({
      platform: "win32",
      online: true,
      deviceName: "My iPod",
    });
    expect(reason).toMatch(/macOS and Linux only/i);
    expect(reason).toMatch(/Safely Remove Hardware/i);
  });

  it("reports the platform before the connection state", () => {
    // A Windows user with an unplugged device should not be told to plug it in:
    // it would not help.
    expect(
      ejectDisabledReason({ platform: "win32", online: false, deviceName: "My iPod" })
    ).toMatch(/macOS and Linux only/i);
  });

  it("names the device when it is not connected", () => {
    expect(
      ejectDisabledReason({ platform: "darwin", online: false, deviceName: "My iPod" })
    ).toBe("'My iPod' is not connected. Plug it in to eject it.");
  });

  it("treats an unresolved ping as offline", () => {
    // `onlineStatus[id]` is null until the ping lands. Enabling the button in
    // that window would let a click through for a device that turns out to be
    // unplugged.
    for (const online of [null, undefined]) {
      expect(
        ejectDisabledReason({ platform: "linux", online, deviceName: "My iPod" })
      ).toMatch(/not connected/i);
    }
  });

  it("returns null on a supported platform with the device connected", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(
        ejectDisabledReason({ platform, online: true, deviceName: "My iPod" })
      ).toBeNull();
    }
  });

  it("refuses a missing preload bridge rather than assuming a platform", () => {
    expect(
      ejectDisabledReason({ platform: undefined, online: true, deviceName: "My iPod" })
    ).toMatch(/macOS and Linux only/i);
  });
});
