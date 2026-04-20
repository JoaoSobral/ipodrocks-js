/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { rocksToStars, starsToRocks } from "../shared/ratings";

describe("rocksToStars", () => {
  it("converts 0 to 0 stars", () => expect(rocksToStars(0)).toBe(0));
  it("converts 10 to 5 stars", () => expect(rocksToStars(10)).toBe(5));
  it("converts 6 to 3 stars", () => expect(rocksToStars(6)).toBe(3));
  it("converts 5 to 2.5 stars (half-star)", () => expect(rocksToStars(5)).toBe(2.5));
  it("returns null for null input", () => expect(rocksToStars(null)).toBeNull());
});

describe("starsToRocks", () => {
  it("converts 0 stars to 0", () => expect(starsToRocks(0)).toBe(0));
  it("converts 5 stars to 10", () => expect(starsToRocks(5)).toBe(10));
  it("converts 3 stars to 6", () => expect(starsToRocks(3)).toBe(6));
  it("converts 2.5 stars to 5 (half-star)", () => expect(starsToRocks(2.5)).toBe(5));
  it("converts 0.5 stars to 1", () => expect(starsToRocks(0.5)).toBe(1));
  it("returns null for null input", () => expect(starsToRocks(null)).toBeNull());
  it("throws RangeError for value above 5", () => expect(() => starsToRocks(6)).toThrow(RangeError));
  it("throws RangeError for negative value", () => expect(() => starsToRocks(-1)).toThrow(RangeError));
  it("round-trips with rocksToStars for integer star values", () => {
    for (let stars = 0; stars <= 5; stars++) {
      expect(rocksToStars(starsToRocks(stars)!)).toBe(stars);
    }
  });
});
