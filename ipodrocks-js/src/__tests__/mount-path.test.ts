/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import { sanitizeMountPath } from "../main/path-allowlist";

describe("sanitizeMountPath", () => {
  it("returns the resolved absolute path for a normal mount", () => {
    const abs = path.resolve("/Volumes/IPOD");
    expect(sanitizeMountPath("/Volumes/IPOD")).toBe(abs);
  });

  it("trims surrounding whitespace", () => {
    const abs = path.resolve("/Volumes/IPOD");
    expect(sanitizeMountPath("  /Volumes/IPOD  ")).toBe(abs);
  });

  it("normalizes traversal segments", () => {
    const resolved = sanitizeMountPath("/Volumes/IPOD/../IPOD2");
    expect(resolved).toBe(path.resolve("/Volumes/IPOD2"));
    expect(resolved).not.toContain("..");
  });

  it("rejects empty / non-string input", () => {
    expect(() => sanitizeMountPath("")).toThrow(/empty/i);
    expect(() => sanitizeMountPath("   ")).toThrow(/empty/i);
    expect(() => sanitizeMountPath(undefined)).toThrow(/empty/i);
  });

  it("rejects null bytes", () => {
    expect(() => sanitizeMountPath("/Volumes/IPOD\0evil")).toThrow(/invalid/i);
  });

  it("rejects a bare POSIX filesystem root (mirror-delete safety)", () => {
    expect(() => sanitizeMountPath("/", "linux")).toThrow(/root/i);
    expect(() => sanitizeMountPath("/", "darwin")).toThrow(/root/i);
  });

  // Regression: issue #98 — on Windows an iPod/Rockbox device mounts at its
  // drive root (E:\), which must be accepted. Mirror sync only deletes inside
  // the Music/Podcasts/Audiobooks subfolders, so a drive root is safe.
  it("accepts a Windows drive root", () => {
    expect(sanitizeMountPath("E:\\", "win32")).toBe("E:\\");
    expect(sanitizeMountPath("D:\\", "win32")).toBe("D:\\");
    expect(sanitizeMountPath("  E:\\  ", "win32")).toBe("E:\\");
    // A subfolder under a drive root is likewise fine.
    expect(sanitizeMountPath("E:\\Music", "win32")).toBe("E:\\Music");
  });
});
