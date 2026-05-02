/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Must hoist the mock before imports
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("../main/podcasts/podcast-index-client", async (importOriginal) => {
  // We need to override fetch. Import the real module but globally replace fetch.
  const actual = await importOriginal();
  return actual;
});

// Provide a global fetch mock for the node env
globalThis.fetch = mockFetch;

import { searchPodcasts, getEpisodes } from "../main/podcasts/podcast-index-client";

const API_KEY = "testapikey";
const API_SECRET = "testapisecret";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("searchPodcasts", () => {
  it("builds correct auth headers and returns mapped results", async () => {
    const mockFeeds = [
      {
        id: 1,
        title: "My Podcast",
        author: "Host",
        description: "A show",
        image: "https://example.com/img.jpg",
        url: "https://example.com/feed.xml",
        episodeCount: 42,
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ feeds: mockFeeds }),
    });

    const results = await searchPodcasts("test term", API_KEY, API_SECRET);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/search/byterm");
    expect(url).toContain("max=50");
    expect(url).toContain("test%20term");
    expect(options.headers["X-Auth-Key"]).toBe(API_KEY);
    expect(options.headers["X-Auth-Date"]).toMatch(/^\d+$/);
    // Authorization is HMAC-SHA256(apiSecret, apiKey + authDate)
    expect(options.headers["Authorization"]).toMatch(/^[a-f0-9]{64}$/);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      feedId: 1,
      title: "My Podcast",
      author: "Host",
      feedUrl: "https://example.com/feed.xml",
      episodeCount: 42,
    });
  });

  it("throws when the API returns a non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(searchPodcasts("q", API_KEY, API_SECRET)).rejects.toThrow("401");
  });

  it("returns empty array when feeds is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });
    const results = await searchPodcasts("q", API_KEY, API_SECRET);
    expect(results).toHaveLength(0);
  });
});

describe("getEpisodes", () => {
  it("queries by feed ID and returns mapped episodes", async () => {
    const mockItems = [
      {
        guid: "guid-1",
        title: "Episode 1",
        description: "Desc",
        enclosureUrl: "https://example.com/ep1.mp3",
        enclosureLength: 50000000,
        duration: 3600,
        datePublished: 1700000000,
        feedId: 99,
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: mockItems }),
    });

    const episodes = await getEpisodes(99, 5, API_KEY, API_SECRET);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("id=99");
    expect(url).toContain("max=5");

    expect(episodes).toHaveLength(1);
    expect(episodes[0].guid).toBe("guid-1");
    expect(episodes[0].duration).toBe(3600);
  });
});
