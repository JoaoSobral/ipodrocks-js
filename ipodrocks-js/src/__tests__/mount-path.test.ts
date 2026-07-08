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

  it("rejects a bare filesystem root (mirror-delete safety)", () => {
    const root = path.parse(process.cwd()).root; // "/" on posix, "C:\\" on win
    expect(() => sanitizeMountPath(root)).toThrow(/root/i);
  });
});
