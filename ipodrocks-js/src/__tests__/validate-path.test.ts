/**
 * @vitest-environment node
 *
 * Tests for folder path validation logic used in IPC handlers.
 * The validateFolderPath function is not exported from ipc.ts,
 * so we replicate its core logic here with an injectable statSync
 * to avoid ESM spying limitations.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";

type StatResult = { isDirectory: () => boolean };

/**
 * Replicates the validateFolderPath logic from ipc.ts, accepting
 * an injectable statSync function for testability.
 */
function validateFolderPath(
  rawPath: string,
  statSync: (p: string) => StatResult = () => ({ isDirectory: () => true })
): { path: string } | { error: string } {
  if (!rawPath || typeof rawPath !== "string") {
    return { error: "Invalid path" };
  }
  const resolved = path.resolve(rawPath.trim());
  if (resolved.split(path.sep).includes("..")) {
    return { error: "Path must not contain parent traversal" };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { error: "Path is not a directory" };
    }
  } catch {
    return { error: "Path does not exist or is not accessible" };
  }
  return { path: resolved };
}

const dirStat = (): StatResult => ({ isDirectory: () => true });
const fileStat = (): StatResult => ({ isDirectory: () => false });
const throwStat = (): StatResult => {
  throw new Error("ENOENT");
};

describe("validateFolderPath", () => {
  it("rejects empty string", () => {
    const result = validateFolderPath("");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe("Invalid path");
  });

  it("rejects null-like values", () => {
    const result = validateFolderPath(null as unknown as string);
    expect("error" in result).toBe(true);
  });

  it("rejects non-string values", () => {
    const result = validateFolderPath(42 as unknown as string);
    expect("error" in result).toBe(true);
  });

  it("resolves and trims whitespace from path", () => {
    const result = validateFolderPath("  /tmp  ", dirStat);
    expect("path" in result).toBe(true);
    expect((result as { path: string }).path).toBe(path.resolve("/tmp"));
  });

  it("accepts valid directory path", () => {
    const result = validateFolderPath("/home/user/music", dirStat);
    expect("path" in result).toBe(true);
    expect((result as { path: string }).path).toBe(
      path.resolve("/home/user/music")
    );
  });

  it("rejects path that is a file, not a directory", () => {
    const result = validateFolderPath("/home/user/file.txt", fileStat);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe(
      "Path is not a directory"
    );
  });

  it("rejects non-existent path", () => {
    const result = validateFolderPath("/does/not/exist", throwStat);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toBe(
      "Path does not exist or is not accessible"
    );
  });

  it("allows paths with double-dot substrings that are not traversal", () => {
    const result = validateFolderPath("/home/user/foo..bar", dirStat);
    expect("path" in result).toBe(true);
  });

  it("does not false-positive on resolved traversal paths", () => {
    // path.resolve normalizes "/a/../b" to "/b"
    const result = validateFolderPath("/a/../b", dirStat);
    expect("path" in result).toBe(true);
    expect((result as { path: string }).path).toBe(path.resolve("/b"));
  });
});
