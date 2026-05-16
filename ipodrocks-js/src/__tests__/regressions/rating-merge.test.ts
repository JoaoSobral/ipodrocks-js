/**
 * @vitest-environment node
 *
 * Regression coverage for the pure `mergeRating` 3-way merge — historically
 * fragile (silent overwrites of library ratings on first observation, missed
 * propagations after a library edit).
 */
import { describe, it, expect } from "vitest";

import { mergeRating } from "../../main/sync/rating-merge";

describe("mergeRating — regressions", () => {
  it("first observation with unrated library adopts the device value", () => {
    expect(mergeRating(null, 6, null, null, 0, 0)).toEqual({
      action: "adopt_device",
      value: 6,
    });
  });

  it("first observation with library = device converges", () => {
    expect(mergeRating(null, 6, 6, null, 0, 0)).toEqual({
      action: "converged",
      value: 6,
    });
  });

  it("first observation with library != device queues a conflict", () => {
    expect(mergeRating(null, 4, 8, null, 0, 0)).toEqual({
      action: "conflict",
      canonical: 8,
      deviceProposed: 4,
    });
  });

  it("no changes on either side is a noop", () => {
    expect(mergeRating(5, 5, 5, 5, 1, 1)).toEqual({ action: "noop", value: 5 });
  });

  it("device changed, library unchanged adopts device", () => {
    expect(mergeRating(5, 7, 5, 5, 1, 1)).toEqual({
      action: "adopt_device",
      value: 7,
    });
  });

  it("library changed, device unchanged propagates library", () => {
    expect(mergeRating(5, 5, 8, 5, 1, 2)).toEqual({
      action: "propagate_lib",
      value: 8,
    });
  });

  it("both changed to the same value converges", () => {
    expect(mergeRating(5, 7, 7, 5, 1, 2)).toEqual({ action: "converged", value: 7 });
  });

  it("both changed and diff <= 1 silently takes max (half-step tolerance)", () => {
    expect(mergeRating(5, 7, 6, 5, 1, 2)).toEqual({ action: "converged", value: 7 });
  });

  it("both changed and diff > 1 produces a conflict", () => {
    expect(mergeRating(5, 4, 9, 5, 1, 2)).toEqual({
      action: "conflict",
      canonical: 9,
      deviceProposed: 4,
    });
  });

  it("rating_version bump alone counts as a library change even if value matches", () => {
    // libraryVal unchanged from baseline, but rating_version > ratingVersionAtSync
    // should still be treated as a library change → propagate_lib if device unchanged.
    expect(mergeRating(5, 5, 5, 5, 1, 2)).toEqual({
      action: "propagate_lib",
      value: 5,
    });
  });
});
