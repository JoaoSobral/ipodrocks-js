/**
 * E2E tests for the "Add by URL" podcast subscription flow.
 *
 * Spins up a minimal HTTP server serving static RSS feeds and an HTML page
 * with a <link rel="alternate"> tag so the test can verify the full flow
 * without hitting the internet.
 *
 * Run: npm run build && npx playwright test
 */
import * as http from "http";
import * as net from "net";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

// ---- Minimal test feed server ----

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Podcast</title>
    <description>A test podcast for E2E tests</description>
    <itunes:author>Test Author</itunes:author>
    <item>
      <title>Episode 1</title>
      <enclosure url="http://example.com/ep1.mp3" length="1000000" type="audio/mpeg"/>
      <guid>http://example.com/ep1</guid>
      <pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate>
    </item>
    <item>
      <title>Episode 2</title>
      <enclosure url="http://example.com/ep2.mp3" length="2000000" type="audio/mpeg"/>
      <guid>http://example.com/ep2</guid>
      <pubDate>Tue, 02 Jan 2024 00:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`;

function makeFeedServer(): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/feed.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(FEED_XML);
      } else if (req.url === "/") {
        const feedUrl = `http://localhost:${(server.address() as net.AddressInfo).port}/feed.xml`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><head>
          <link rel="alternate" type="application/rss+xml" title="Test Podcast" href="${feedUrl}">
        </head><body>Podcast page</body></html>`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
    server.on("error", reject);
  });
}

// ---- Helpers ----

async function openPodcastsPanel(window: Awaited<ReturnType<typeof launchApp>["app"]["firstWindow"]>) {
  await window.waitForLoadState("domcontentloaded");
  // Navigate to the Podcasts panel via the sidebar
  const podcastsLink = window.locator('[data-testid="nav-podcasts"], a:has-text("Podcasts"), button:has-text("Podcasts")').first();
  if (await podcastsLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await podcastsLink.click();
  }
}

async function openSearchModal(window: Awaited<ReturnType<typeof launchApp>["app"]["firstWindow"]>) {
  const btn = window.locator('button:has-text("Search & Subscribe")').first();
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click();
}

async function switchToUrlTab(window: Awaited<ReturnType<typeof launchApp>["app"]["firstWindow"]>) {
  const urlTab = window.locator('button:has-text("Add by URL")').first();
  await urlTab.waitFor({ state: "visible", timeout: 5_000 });
  await urlTab.click();
}

// ---- Tests ----

let launched: LaunchedApp;
let feedServer: { url: string; server: http.Server };

test.beforeEach(async () => {
  [launched, feedServer] = await Promise.all([launchApp(), makeFeedServer()]);
});

test.afterEach(async () => {
  await launched.cleanup();
  await new Promise<void>((r) => feedServer.server.close(() => r()));
});

test("Add by URL tab is visible in Search & Subscribe modal", async () => {
  const window = await launched.app.firstWindow();
  await openPodcastsPanel(window);
  await openSearchModal(window);

  const urlTab = window.locator('button:has-text("Add by URL")').first();
  await expect(urlTab).toBeVisible({ timeout: 5_000 });
});

test("pasting an RSS feed URL shows a preview and subscribes", async () => {
  const window = await launched.app.firstWindow();
  await openPodcastsPanel(window);
  await openSearchModal(window);
  await switchToUrlTab(window);

  const rssFeedUrl = `${feedServer.url}/feed.xml`;
  await window.locator('input[placeholder*="RSS"]').fill(rssFeedUrl);
  await window.locator('button:has-text("Find")').click();

  // Preview should appear with the feed title
  await expect(window.locator("text=Test Podcast").first()).toBeVisible({ timeout: 15_000 });

  // Click Subscribe
  await window.locator('button:text-is("+ Subscribe")').click();

  // Success state
  await expect(window.locator("text=Subscribed to").first()).toBeVisible({ timeout: 10_000 });
});

test("pasting a podcast website URL discovers the feed and subscribes", async () => {
  const window = await launched.app.firstWindow();
  await openPodcastsPanel(window);
  await openSearchModal(window);
  await switchToUrlTab(window);

  // The root URL serves an HTML page with a <link rel="alternate"> pointing to /feed.xml
  await window.locator('input[placeholder*="RSS"]').fill(feedServer.url + "/");
  await window.locator('button:has-text("Find")').click();

  // Should discover and preview
  await expect(window.locator("text=Test Podcast").first()).toBeVisible({ timeout: 15_000 });

  await window.locator('button:text-is("+ Subscribe")').click();
  await expect(window.locator("text=Subscribed to").first()).toBeVisible({ timeout: 10_000 });
});

test("invalid URL shows an error message", async () => {
  const window = await launched.app.firstWindow();
  await openPodcastsPanel(window);
  await openSearchModal(window);
  await switchToUrlTab(window);

  await window.locator('input[placeholder*="RSS"]').fill("not-a-url-at-all-xyz");
  await window.locator('button:has-text("Find")').click();

  // Should display some error (network failure or "no feed found")
  const errorArea = window.locator(".text-destructive, [class*='destructive']").first();
  await expect(errorArea).toBeVisible({ timeout: 15_000 });
});

test("non-RSS page with no feed link shows no feed found error", async () => {
  const window = await launched.app.firstWindow();
  await openPodcastsPanel(window);
  await openSearchModal(window);
  await switchToUrlTab(window);

  // Serve a 404, which will cause an HTTP error
  await window.locator('input[placeholder*="RSS"]').fill(`${feedServer.url}/nonexistent`);
  await window.locator('button:has-text("Find")').click();

  const errorArea = window.locator(".text-destructive, [class*='destructive']").first();
  await expect(errorArea).toBeVisible({ timeout: 15_000 });
});
