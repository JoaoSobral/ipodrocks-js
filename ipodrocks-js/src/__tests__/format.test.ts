/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatSize,
  formatBitrate,
  formatShadowSize,
} from "../renderer/utils/format";

describe("format utilities", () => {
  describe("formatDuration", () => {
    it("formats zero seconds", () => {
      expect(formatDuration(0)).toBe("0:00");
    });

    it("formats seconds under a minute", () => {
      expect(formatDuration(45)).toBe("0:45");
    });

    it("pads single-digit seconds", () => {
      expect(formatDuration(62)).toBe("1:02");
    });

    it("formats several minutes", () => {
      expect(formatDuration(234)).toBe("3:54");
    });

    it("handles fractional seconds by flooring", () => {
      expect(formatDuration(90.7)).toBe("1:30");
    });

    it("formats long durations (over an hour)", () => {
      expect(formatDuration(3661)).toBe("61:01");
    });
  });

  describe("formatSize", () => {
    it("formats zero bytes", () => {
      expect(formatSize(0)).toBe("0.0 MB");
    });

    it("formats megabytes", () => {
      expect(formatSize(5_500_000)).toBe("5.5 MB");
    });

    it("formats gigabyte-range values in MB", () => {
      expect(formatSize(1_000_000_000)).toBe("1000.0 MB");
    });
  });

  describe("formatBitrate", () => {
    it("returns dash for zero", () => {
      expect(formatBitrate(0)).toBe("—");
    });

    it("formats kilobits per second", () => {
      expect(formatBitrate(320_000)).toBe("320 kbps");
    });

    it("formats low bitrate", () => {
      expect(formatBitrate(128_000)).toBe("128 kbps");
    });

    it("formats megabit range", () => {
      expect(formatBitrate(1_500_000)).toBe("1.5 Mbps");
    });
  });

  describe("formatShadowSize", () => {
    it("returns 0.0 GB for zero", () => {
      expect(formatShadowSize(0)).toBe("0.0 GB");
    });

    it("returns 0.0 GB for negative values", () => {
      expect(formatShadowSize(-1)).toBe("0.0 GB");
    });

    it("formats gigabytes", () => {
      expect(formatShadowSize(5_400_000_000)).toBe("5.4 GB");
    });

    it("formats sub-gigabyte values", () => {
      expect(formatShadowSize(500_000_000)).toBe("0.5 GB");
    });
  });
});
