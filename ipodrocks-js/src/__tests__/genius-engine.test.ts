/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  getAvailableGeniusTypes,
  buildAnalysisSummary,
} from "../main/playlists/genius-engine";

describe("genius-engine", () => {
  describe("getAvailableGeniusTypes", () => {
    it("returns array of genius type options", () => {
      const types = getAvailableGeniusTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
      expect(types[0]).toHaveProperty("value");
      expect(types[0]).toHaveProperty("label");
      expect(types[0]).toHaveProperty("description");
    });
  });

  describe("buildAnalysisSummary", () => {
    it("builds summary from events", () => {
      const events: { timestamp: number; completionRatio: number }[] = [
        { timestamp: 1000, completionRatio: 1 },
        { timestamp: 2000, completionRatio: 0.5 },
      ];
      const matched = events.map((e, i) => ({
        ...e,
        trackId: i + 1,
        artist: "A",
        album: "B",
        title: "T",
        genre: "G",
        duration: 180,
      }));
      const summary = buildAnalysisSummary(events as never, matched as never);
      expect(summary.totalPlays).toBe(2);
      expect(summary.matchedPlays).toBe(2);
    });
  });
});
