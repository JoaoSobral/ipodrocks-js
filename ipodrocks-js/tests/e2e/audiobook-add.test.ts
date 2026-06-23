/**
 * E2E tests for the Auto Audiobooks (LibriVox) feature.
 *
 * Spins up a minimal HTTP server that stubs the LibriVox JSON API and a
 * per-book RSS chapter feed so tests run without internet access.
 *
 * The librivox-client.ts export `setLibrivoxBaseUrl` is used via
 * LIBRIVOX_BASE_URL env var (set via electron-builder / test env) to redirect
 * API calls to our local stub.
 *
 * Run: npm run build && npx playwright test
 */
import * as http from "http";
import * as net from "net";
import { test, expect } from "@playwright/test";
import { launchApp, type LaunchedApp } from "./electron-launcher";

// ---- Stub server ----

const CHAPTER_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Pride and Prejudice</title>
    <item>
      <title>Chapter 01</title>
      <enclosure url="http://example.com/ch1.mp3" length="1000000" type="audio/mpeg"/>
      <guid>pride-ch1</guid>
    </item>
    <item>
      <title>Chapter 02</title>
      <enclosure url="http://example.com/ch2.mp3" length="1200000" type="audio/mpeg"/>
      <guid>pride-ch2</guid>
    </item>
  </channel>
</rss>`;

// Minimal valid 2x2 baseline JPEG for cover stub. Must be a real, decodable
// image — the panel's <img> sets display:none onError, so a malformed stub
// would render hidden and fail the visibility assertion below.
const STUB_COVER_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQY" +
  "GBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYa" +
  "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAAR" +
  "CAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAA" +
  "AAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAM" +
  "AwEAAhEDEQA/AI4BOOv/2Q==",
  "base64"
);

function makeStubServer(): Promise<{ url: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const port = (server.address() as net.AddressInfo).port;

      if (req.url?.startsWith("/api/feed/audiobooks")) {
        // Stub LibriVox search API
        const body = JSON.stringify({
          books: [
            {
              id: "12345",
              title: "Pride and Prejudice",
              description: "A classic novel by Jane Austen.",
              language: "English",
              num_sections: "2",
              totaltimesecs: "5400",
              url_rss: `http://127.0.0.1:${port}/chapters.xml`,
              authors: [{ first_name: "Jane", last_name: "Austen" }],
            },
          ],
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else if (req.url === "/chapters.xml") {
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(CHAPTER_FEED_XML);
      } else if (req.url?.startsWith("/books/v1/volumes")) {
        // Stub Google Books cover API
        const coverUrl = `http://127.0.0.1:${port}/cover.jpg`;
        const body = JSON.stringify({
          items: [{ volumeInfo: { imageLinks: { thumbnail: coverUrl } } }],
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else if (req.url === "/cover.jpg") {
        res.writeHead(200, { "Content-Type": "image/jpeg" });
        res.end(STUB_COVER_BYTES);
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

type Window = Awaited<ReturnType<LaunchedApp["app"]["firstWindow"]>>;

async function openAudiobooksPanel(window: Window) {
  await window.waitForLoadState("domcontentloaded");
  const link = window
    .locator('button:has-text("Extra Audiobooks"), [data-testid="nav-autoaudiobooks"]')
    .first();
  await link.waitFor({ state: "visible", timeout: 10_000 });
  await link.click();
}

async function openSearchModal(window: Window) {
  const btn = window.locator('button:has-text("Search & Add")').first();
  await btn.waitFor({ state: "visible", timeout: 10_000 });
  await btn.click();
}

// ---- Tests ----

let launched: LaunchedApp;
let stubServer: { url: string; server: http.Server };

test.beforeEach(async () => {
  // Start stub server first so we can pass its URL into the app env
  stubServer = await makeStubServer();
  launched = await launchApp({
    LIBRIVOX_BASE_URL: stubServer.url,
    GOOGLE_BOOKS_BASE_URL: stubServer.url,
    OPENLIBRARY_BASE_URL: stubServer.url,
    OPENLIBRARY_COVERS_BASE_URL: stubServer.url,
  });
});

test.afterEach(async () => {
  await launched.cleanup();
  await new Promise<void>((r) => stubServer.server.close(() => r()));
});

test("searching and adding a LibriVox book shows it in the panel", async () => {
  const window = await launched.app.firstWindow();
  await openAudiobooksPanel(window);

  // Panel should show empty state initially
  await expect(window.locator('text=No audiobooks yet').first()).toBeVisible({ timeout: 8_000 });

  await openSearchModal(window);

  // Type a search query
  const input = window.locator('input[placeholder*="Search by title"]').first();
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill("Pride");

  // Wait for stub results to appear (debounce + API call)
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 15_000 });

  // Click Add
  const addBtn = window.locator('button:text-is("Add")').first();
  await addBtn.click();

  // Button should change to "Added"
  await expect(window.locator('button:text-is("Added")').first()).toBeVisible({ timeout: 8_000 });

  // Close modal
  const closeBtn = window.locator('[aria-label="Close"], button:has-text("Close"), [data-testid="modal-close"]').first();
  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click();
  } else {
    await window.keyboard.press("Escape");
  }

  // Book should appear in the panel grid
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 10_000 });
});

test("added audiobook appears in Sync panel Audiobooks list with Auto badge", async () => {
  const window = await launched.app.firstWindow();
  await openAudiobooksPanel(window);
  await openSearchModal(window);

  const input = window.locator('input[placeholder*="Search by title"]').first();
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill("Pride");
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 15_000 });
  await window.locator('button:text-is("Add")').first().click();
  await expect(window.locator('button:text-is("Added")').first()).toBeVisible({ timeout: 8_000 });

  // Close the search modal so its backdrop doesn't block nav clicks
  await window.keyboard.press("Escape");

  // Navigate to Sync panel
  const syncLink = window.locator('button:has-text("Sync")').first();
  await syncLink.click();

  // Switch to custom sync mode
  const customRadio = window.locator('input[value="custom"], label:has-text("Custom")').first();
  if (await customRadio.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await customRadio.click();
  }

  // The Audiobooks section should show the book with an "Auto" badge
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 10_000 });
  await expect(window.locator("text=Auto").first()).toBeVisible({ timeout: 5_000 });
});

test("removing an auto-audiobook removes it from the panel", async () => {
  const window = await launched.app.firstWindow();
  await openAudiobooksPanel(window);
  await openSearchModal(window);

  const input = window.locator('input[placeholder*="Search by title"]').first();
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill("Pride");
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 15_000 });
  await window.locator('button:text-is("Add")').first().click();
  await expect(window.locator('button:text-is("Added")').first()).toBeVisible({ timeout: 8_000 });
  await window.keyboard.press("Escape");

  // Open the detail modal
  await window.locator("text=Pride and Prejudice").first().click();
  const removeBtn = window.locator('button:has-text("Remove Book")').first();
  await removeBtn.waitFor({ state: "visible", timeout: 5_000 });
  await removeBtn.click();

  // Panel should return to empty state
  await expect(window.locator("text=No audiobooks yet").first()).toBeVisible({ timeout: 10_000 });
});

test("added audiobook shows a cover image in the panel", async () => {
  const window = await launched.app.firstWindow();
  await openAudiobooksPanel(window);
  await openSearchModal(window);

  const input = window.locator('input[placeholder*="Search by title"]').first();
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill("Pride");
  await expect(window.locator("text=Pride and Prejudice").first()).toBeVisible({ timeout: 15_000 });
  await window.locator('button:text-is("Add")').first().click();
  await expect(window.locator('button:text-is("Added")').first()).toBeVisible({ timeout: 8_000 });
  await window.keyboard.press("Escape");

  // Wait for cover download (async after subscribe) and check <img> is rendered
  const coverImg = window.locator(
    '.aspect-square img, [class*="aspect-square"] img'
  ).first();
  await expect(coverImg).toBeVisible({ timeout: 10_000 });
});
