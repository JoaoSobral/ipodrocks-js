import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyInput } from "../main/podcasts/podcast-feed-import";
import { stableRssFeedId } from "../main/podcasts/podcast-subscriptions";

// ---- classifyInput ----

describe("classifyInput", () => {
  it("classifies .xml extension as rss", () => {
    expect(classifyInput("https://example.com/feed.xml")).toBe("rss");
  });

  it("classifies .rss extension as rss", () => {
    expect(classifyInput("https://example.com/show.rss")).toBe("rss");
  });

  it("classifies /feed path as rss", () => {
    expect(classifyInput("https://example.com/feed")).toBe("rss");
    expect(classifyInput("https://example.com/feed/")).toBe("rss");
  });

  it("classifies /rss path as rss", () => {
    expect(classifyInput("https://example.com/rss")).toBe("rss");
  });

  it("classifies /podcast.xml path as rss", () => {
    expect(classifyInput("https://example.com/podcast.xml")).toBe("rss");
  });

  it("classifies format=rss query param as rss", () => {
    expect(classifyInput("https://example.com/episodes?format=rss")).toBe("rss");
  });

  it("classifies normal website URL as website", () => {
    expect(classifyInput("https://example.com")).toBe("website");
  });

  it("classifies URL with .html extension as website", () => {
    expect(classifyInput("https://example.com/page.html")).toBe("website");
  });
});

// ---- stableRssFeedId ----

describe("stableRssFeedId", () => {
  it("is always negative", () => {
    const id = stableRssFeedId("https://example.com/feed.xml");
    expect(id).toBeLessThan(0);
  });

  it("is deterministic for the same URL", () => {
    const url = "https://testpodcast.com/rss";
    expect(stableRssFeedId(url)).toBe(stableRssFeedId(url));
  });

  it("is different for different URLs", () => {
    expect(stableRssFeedId("https://a.com/feed")).not.toBe(
      stableRssFeedId("https://b.com/feed")
    );
  });

  it("never returns 0", () => {
    // Verify our hash never produces the special 0 case for common inputs
    const urls = [
      "https://example.com/feed.xml",
      "https://feeds.simplecast.com/abc123",
      "https://anchor.fm/s/abc/podcast/rss",
    ];
    for (const url of urls) {
      expect(stableRssFeedId(url)).not.toBe(0);
    }
  });
});

// ---- fetchAndParseFeed ----

const VALID_FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>My Podcast</title>
    <description>A great podcast</description>
    <itunes:author>Jane Doe</itunes:author>
    <image><url>https://example.com/art.jpg</url></image>
    <item>
      <title>Episode 1</title>
      <guid>https://example.com/ep1</guid>
      <enclosure url="https://example.com/ep1.mp3" length="5000000" type="audio/mpeg"/>
      <itunes:duration>30:00</itunes:duration>
      <pubDate>Mon, 01 Jan 2024 12:00:00 +0000</pubDate>
      <description>First episode description</description>
    </item>
    <item>
      <title>Episode 2</title>
      <guid>https://example.com/ep2</guid>
      <enclosure url="https://example.com/ep2.mp3" length="6000000" type="audio/mpeg"/>
      <itunes:duration>1:00:00</itunes:duration>
      <pubDate>Tue, 02 Jan 2024 12:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

const FEED_NO_ARTWORK = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>No Artwork Podcast</title>
    <item>
      <title>Ep 1</title>
      <guid>ep1</guid>
      <enclosure url="https://example.com/ep1.mp3" length="1000" type="audio/mpeg"/>
      <pubDate>Mon, 01 Jan 2024 12:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

describe("fetchAndParseFeed", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  function mockFetch(body: string, contentType = "application/rss+xml") {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://example.com/feed.xml",
      headers: { get: () => contentType },
      text: async () => body,
    } as unknown as Response);
  }

  it("parses title, author, description, and imageUrl", async () => {
    mockFetch(VALID_FEED);
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    const result = await fetchAndParseFeed("https://example.com/feed.xml");
    expect(result.title).toBe("My Podcast");
    expect(result.author).toBe("Jane Doe");
    expect(result.description).toBe("A great podcast");
    expect(result.imageUrl).toBe("https://example.com/art.jpg");
  });

  it("parses episodes with guid, title, enclosureUrl, duration", async () => {
    mockFetch(VALID_FEED);
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    const result = await fetchAndParseFeed("https://example.com/feed.xml");
    expect(result.episodes).toHaveLength(2);
    const ep1 = result.episodes[0];
    expect(ep1.guid).toBe("https://example.com/ep1");
    expect(ep1.title).toBe("Episode 1");
    expect(ep1.enclosureUrl).toBe("https://example.com/ep1.mp3");
    expect(ep1.durationSeconds).toBe(1800); // 30:00
  });

  it("parses HH:MM:SS duration", async () => {
    mockFetch(VALID_FEED);
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    const result = await fetchAndParseFeed("https://example.com/feed.xml");
    expect(result.episodes[1].durationSeconds).toBe(3600); // 1:00:00
  });

  it("returns null imageUrl when feed has no artwork", async () => {
    mockFetch(FEED_NO_ARTWORK);
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    const result = await fetchAndParseFeed("https://example.com/feed.xml");
    expect(result.imageUrl).toBeNull();
  });

  it("throws on non-XML response", async () => {
    mockFetch("<html>not a feed</html>", "text/html");
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    // HTML can be parsed by the XML parser; the error will be "no channel"
    await expect(fetchAndParseFeed("https://example.com/feed.xml")).rejects.toThrow();
  });

  it("throws when fetch fails (HTTP error)", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      url: "https://example.com/feed.xml",
    } as unknown as Response);
    const { fetchAndParseFeed } = await import("../main/podcasts/podcast-feed-import");
    await expect(fetchAndParseFeed("https://example.com/feed.xml")).rejects.toThrow("HTTP 404");
  });
});
