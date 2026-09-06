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
