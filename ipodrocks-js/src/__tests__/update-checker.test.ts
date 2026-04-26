/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  compareVersions,
  shouldAutoCheck,
  fetchLatestRelease,
} from "../main/utils/update-checker";

describe("compareVersions", () => {
  it("returns -1 when current is behind latest", () => {
    expect(compareVersions("1.3.0", "1.4.0")).toBe(-1);
  });

  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.3.0", "1.3.0")).toBe(0);
  });

  it("strips leading v from either side", () => {
    expect(compareVersions("v1.3.0", "1.3.0")).toBe(0);
    expect(compareVersions("1.3.0", "v1.3.0")).toBe(0);
  });

  it("returns -1 for patch increment", () => {
    expect(compareVersions("1.3.0", "1.3.1")).toBe(-1);
  });

  it("returns 1 when current is ahead of latest", () => {
    expect(compareVersions("2.0.0", "1.99.0")).toBe(1);
  });

  it("returns 1 when current minor is ahead", () => {
    expect(compareVersions("1.5.0", "1.4.9")).toBe(1);
  });
});

describe("shouldAutoCheck", () => {
  it("returns true when snooze is unset", () => {
    expect(shouldAutoCheck(Date.now(), undefined)).toBe(true);
  });

  it("returns true when snooze is in the past", () => {
    const past = Date.now() - 1000;
    expect(shouldAutoCheck(Date.now(), past)).toBe(true);
  });

  it("returns false when snooze is in the future", () => {
    const future = Date.now() + 1_000_000;
    expect(shouldAutoCheck(Date.now(), future)).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  it("parses a valid GitHub response", async () => {
    const fakePayload = {
      tag_name: "v1.4.0",
      html_url: "https://github.com/JoaoSobral/ipodrocks-js/releases/tag/v1.4.0",
      name: "iPodRocks 1.4.0",
      published_at: "2026-01-01T00:00:00Z",
    };

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = Object.fromEntries(
        new Headers(init?.headers as HeadersInit).entries()
      );
      return {
        ok: true,
        json: async () => fakePayload,
      } as Response;
    };

    const result = await fetchLatestRelease(mockFetch as typeof fetch);

    expect(capturedUrl).toBe(
      "https://api.github.com/repos/JoaoSobral/ipodrocks-js/releases/latest"
    );
    expect(capturedHeaders["accept"]).toBe("application/vnd.github+json");
    expect(result.tagName).toBe("v1.4.0");
    expect(result.htmlUrl).toBe(fakePayload.html_url);
    expect(result.name).toBe(fakePayload.name);
    expect(result.publishedAt).toBe(fakePayload.published_at);
  });

  it("throws on non-ok response", async () => {
    const mockFetch = async () =>
      ({ ok: false, status: 404 } as Response);

    await expect(
      fetchLatestRelease(mockFetch as typeof fetch)
    ).rejects.toThrow("GitHub API error: 404");
  });
});
