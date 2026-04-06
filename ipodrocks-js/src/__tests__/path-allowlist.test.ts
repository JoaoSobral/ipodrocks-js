/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { pathMatchesAllowedPrefix } from "../main/path-allowlist";

describe("pathMatchesAllowedPrefix", () => {
  describe("win32", () => {
    const p = "win32" as const;

    it("allows D:\\Music under drive prefix D:\\", () => {
      expect(pathMatchesAllowedPrefix("D:\\Music", "D:\\", p)).toBe(true);
    });

    it("allows C:\\Something under drive prefix C:\\ (not only under homedir)", () => {
      expect(pathMatchesAllowedPrefix("C:\\Something", "C:\\", p)).toBe(true);
    });

    it("allows C:\\Users\\X\\Music under homedir prefix C:\\Users\\X", () => {
      expect(
        pathMatchesAllowedPrefix("C:\\Users\\X\\Music", "C:\\Users\\X", p)
      ).toBe(true);
    });

    it("matches drive root exactly case-insensitively", () => {
      expect(pathMatchesAllowedPrefix("d:\\", "D:\\", p)).toBe(true);
      expect(pathMatchesAllowedPrefix("D:\\", "d:\\", p)).toBe(true);
    });

    it("allows lowercase path under uppercase drive prefix", () => {
      expect(pathMatchesAllowedPrefix("d:\\music", "D:\\", p)).toBe(true);
    });

    it("rejects path on another drive", () => {
      expect(pathMatchesAllowedPrefix("E:\\Music", "D:\\", p)).toBe(false);
    });

    it("rejects non-drive prefix that is not a parent path", () => {
      expect(pathMatchesAllowedPrefix("D:\\Other", "C:\\Users\\X", p)).toBe(
        false
      );
    });
  });

  describe("darwin", () => {
    const p = "darwin" as const;

    it("uses prefix + sep for /Volumes", () => {
      expect(
        pathMatchesAllowedPrefix("/Volumes/USB/Music", "/Volumes", p)
      ).toBe(true);
      expect(pathMatchesAllowedPrefix("/Volumes", "/Volumes", p)).toBe(true);
      expect(pathMatchesAllowedPrefix("/etc/passwd", "/Volumes", p)).toBe(
        false
      );
    });
  });

  describe("linux", () => {
    const p = "linux" as const;

    it("uses prefix + sep for /media", () => {
      expect(
        pathMatchesAllowedPrefix("/media/user/disk/Music", "/media", p)
      ).toBe(true);
      expect(pathMatchesAllowedPrefix("/media", "/media", p)).toBe(true);
    });
  });
});
