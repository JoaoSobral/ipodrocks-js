/**
 * @vitest-environment node
 *
 * Tests for device online/offline detection logic mirroring isDeviceMountPathOnline
 * in ipc.ts. A device is considered online only when its mount path is a real
 * mount point — verified by comparing fs.statSync(path).dev against the parent
 * directory's dev. This rejects both orphan mount directories (left after
 * ejection) and local folders masquerading as devices.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";

type StatResult = { dev: number; isDirectory: () => boolean };
type Platform = "darwin" | "linux" | "win32";

function isDeviceMountPathOnline(
  mountPath: string,
  platform: Platform,
  statSync: (p: string) => StatResult
): boolean {
  if (!mountPath) return false;
  try {
    const resolved = path.resolve(mountPath);
    const pathStat = statSync(resolved);
    if (!pathStat.isDirectory()) return false;
    if (platform === "win32") return true;
    const parentStat = statSync(path.dirname(resolved));
    return pathStat.dev !== parentStat.dev;
  } catch {
    return false;
  }
}

const dir = (dev: number): StatResult => ({ dev, isDirectory: () => true });
const file = (dev: number): StatResult => ({ dev, isDirectory: () => false });
const throws = (): StatResult => { throw new Error("ENOENT"); };

describe("isDeviceMountPathOnline", () => {
  it("returns false for empty string", () => {
    expect(isDeviceMountPathOnline("", "darwin", throws)).toBe(false);
  });

  it("returns false when statSync throws (path does not exist)", () => {
    expect(isDeviceMountPathOnline("/Volumes/IPOD", "darwin", throws)).toBe(false);
  });

  it("returns false when path is a file not a directory", () => {
    expect(
      isDeviceMountPathOnline("/Volumes/IPOD", "darwin", () => file(100))
    ).toBe(false);
  });

  describe("external mounts on macOS/Linux (dev differs from parent)", () => {
    it("returns true for real mounted volume on macOS", () => {
      const statSync = (p: string) =>
        p === path.resolve("/Volumes/IPOD") ? dir(999) : dir(1);
      expect(isDeviceMountPathOnline("/Volumes/IPOD", "darwin", statSync)).toBe(true);
    });

    it("returns true for real mounted volume on Linux", () => {
      const statSync = (p: string) =>
        p === path.resolve("/mnt/ipod") ? dir(500) : dir(1);
      expect(isDeviceMountPathOnline("/mnt/ipod", "linux", statSync)).toBe(true);
    });
  });

  describe("orphan directories and local folders (dev same as parent)", () => {
    it("returns false for orphan /Volumes directory after ejection", () => {
      const statSync = (_p: string) => dir(1);
      expect(isDeviceMountPathOnline("/Volumes/IPOD", "darwin", statSync)).toBe(false);
    });

    it("returns false for local folder used as test device on macOS", () => {
      const statSync = (_p: string) => dir(1);
      expect(
        isDeviceMountPathOnline("/Users/pedro/test-device", "darwin", statSync)
      ).toBe(false);
    });

    it("returns false for orphan /mnt directory on Linux", () => {
      const statSync = (_p: string) => dir(1);
      expect(isDeviceMountPathOnline("/mnt/ipod", "linux", statSync)).toBe(false);
    });

    it("returns false for local /home folder used as test device on Linux", () => {
      const statSync = (_p: string) => dir(1);
      expect(
        isDeviceMountPathOnline("/home/user/test-device", "linux", statSync)
      ).toBe(false);
    });
  });

  describe("Windows", () => {
    it("returns true for any existing directory (drive letters are inherently isolated)", () => {
      const statSync = (_p: string) => dir(1);
      expect(isDeviceMountPathOnline("D:\\iPod", "win32", statSync)).toBe(true);
    });

    it("returns false when path does not exist on Windows", () => {
      expect(isDeviceMountPathOnline("D:\\iPod", "win32", throws)).toBe(false);
    });
  });
});
