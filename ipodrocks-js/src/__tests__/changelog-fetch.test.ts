/**
 * @vitest-environment node
 *
 * Covers fetchChangelogMarkdown + its in-memory cache. The cache survives
 * across calls in the same process, so we reset it between cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchChangelogMarkdown,
  _resetChangelogCacheForTests,
} from "../main/utils/update-checker";

describe("fetchChangelogMarkdown", () => {
  beforeEach(() => {
    _resetChangelogCacheForTests();
  });

  it("returns the markdown body when the fetch succeeds", async () => {
    const body = "## [1.0.0]\n\n- Hello\n";
    const fetchImpl = vi.fn(async () =>
      new Response(body, { status: 200 })
    );
    const result = await fetchChangelogMarkdown(fetchImpl as unknown as typeof fetch);
    expect(result).toBe(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null on non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const result = await fetchChangelogMarkdown(fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = await fetchChangelogMarkdown(fetchImpl as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("caches the markdown body across calls", async () => {
    const body = "## [1.0.0]\n\n- Hello\n";
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const first = await fetchChangelogMarkdown(fetchImpl as unknown as typeof fetch);
    const second = await fetchChangelogMarkdown(fetchImpl as unknown as typeof fetch);
    expect(first).toBe(body);
    expect(second).toBe(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache null results — a failed fetch is retried", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await fetchChangelogMarkdown(failing as unknown as typeof fetch);
    expect(failing).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn(async () => new Response("## [2.0.0]\n", { status: 200 }));
    const result = await fetchChangelogMarkdown(succeeding as unknown as typeof fetch);
    expect(result).toBe("## [2.0.0]\n");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
