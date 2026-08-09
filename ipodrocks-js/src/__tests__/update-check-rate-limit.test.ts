/**
 * @vitest-environment node
 *
 * Covers checkRateLimit — the rolling-window cap on update checks (auto +
 * manual, combined) that keeps a single app instance under GitHub's
 * unauthenticated 60/hour API limit.
 */
import { describe, it, expect } from "vitest";
import {
  checkRateLimit,
  UPDATE_CHECK_RATE_LIMIT,
  UPDATE_CHECK_WINDOW_MS,
} from "../main/utils/update-checker";

describe("checkRateLimit", () => {
  it("allows checks up to the limit within the window", () => {
    const now = 1_000_000;
    let timestamps: number[] = [];
    for (let i = 0; i < UPDATE_CHECK_RATE_LIMIT; i++) {
      const result = checkRateLimit(timestamps, now + i);
      expect(result.allowed).toBe(true);
      timestamps = result.timestamps;
    }
    expect(timestamps).toHaveLength(UPDATE_CHECK_RATE_LIMIT);
  });

  it("denies the check after the limit is reached within the window", () => {
    const now = 1_000_000;
    const timestamps = Array.from({ length: UPDATE_CHECK_RATE_LIMIT }, (_, i) => now + i);
    const result = checkRateLimit(timestamps, now + UPDATE_CHECK_RATE_LIMIT);
    expect(result.allowed).toBe(false);
    // Denied checks are not recorded — timestamps come back unchanged (pruned only).
    expect(result.timestamps).toEqual(timestamps);
  });

  it("prunes timestamps older than the window, freeing up budget again", () => {
    const now = 1_000_000;
    const stale = Array.from(
      { length: UPDATE_CHECK_RATE_LIMIT },
      (_, i) => now - UPDATE_CHECK_WINDOW_MS - i
    );
    const result = checkRateLimit(stale, now);
    expect(result.allowed).toBe(true);
    // All stale entries pruned, only the new check remains.
    expect(result.timestamps).toEqual([now]);
  });

  it("respects a custom limit and window", () => {
    const now = 1_000_000;
    const first = checkRateLimit([], now, 1, 1000);
    expect(first.allowed).toBe(true);
    const second = checkRateLimit(first.timestamps, now + 500, 1, 1000);
    expect(second.allowed).toBe(false);
    const third = checkRateLimit(first.timestamps, now + 1500, 1, 1000);
    expect(third.allowed).toBe(true);
  });
});
