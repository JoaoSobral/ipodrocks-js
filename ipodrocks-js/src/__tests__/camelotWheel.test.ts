/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { getCompatibleKeys, normalizeKey, toCamelot } from "../main/harmonic/camelotWheel";

describe("camelotWheel", () => {
  describe("toCamelot", () => {
    it("maps C major to 8B", () => {
      expect(toCamelot("C")).toBe("8B");
    });
    it("maps Am to 8A", () => {
      expect(toCamelot("Am")).toBe("8A");
    });
    it("returns null for unknown key", () => {
      expect(toCamelot("X")).toBeNull();
    });
  });

  describe("normalizeKey", () => {
    it("normalizes 'A minor' to Am", () => {
      expect(normalizeKey("A minor")).toBe("Am");
    });
    it("normalizes 'A major' to A", () => {
      expect(normalizeKey("A major")).toBe("A");
    });
    it("returns null for empty input", () => {
      expect(normalizeKey("")).toBeNull();
      expect(normalizeKey(null)).toBeNull();
    });
  });

  describe("getCompatibleKeys", () => {
    it("returns compatible keys for 8A", () => {
      const keys = getCompatibleKeys("8A");
      expect(keys).toContain("8A");
      expect(keys).toContain("7A");
      expect(keys).toContain("9A");
      expect(keys).toContain("8B");
      expect(keys).toHaveLength(4);
    });
    it("wraps 1 to 12 for prev", () => {
      const keys = getCompatibleKeys("1B");
      expect(keys).toContain("12B");
    });
    it("wraps 12 to 1 for next", () => {
      const keys = getCompatibleKeys("12B");
      expect(keys).toContain("1B");
    });
  });
});
