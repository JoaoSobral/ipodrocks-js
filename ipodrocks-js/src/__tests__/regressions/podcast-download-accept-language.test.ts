/**
 * @vitest-environment node
 *
 * Regression: podcast episodes hosted on CDNs that do language-targeted dynamic
 * ad insertion (e.g. Captivate) failed to download.
 *
 * Node's global `fetch` (undici) sends `Accept-Language: *` by default. Captivate's
 * edge returns **404** for that wildcard instead of 302-redirecting to the stitched
 * MP3, so `downloadEpisode` marked the episode `failed` permanently — exactly the
 * "some podcasts can't download the latest episodes" report for "The News Agents".
 *
 * `downloadEpisode` now sends a concrete `Accept-Language` (via DOWNLOAD_HEADERS).
 * This test stands up a real HTTP server that mimics Captivate — 404 on a wildcard
 * Accept-Language, 200 otherwise — and asserts the download now succeeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

import { createTestDb, closeDb, canRunDbTests, type TestDb } from "../harness";

// downloadEpisode → podcast-storage → electron.app.getPath("userData")
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === "userData") return _testUserData;
      throw new Error("unexpected getPath: " + key);
    }),
  },
}));

let _testUserData = "";

import { downloadEpisode } from "@main/podcasts/podcast-downloader";

/** A Captivate-like server: 404 unless a concrete Accept-Language is sent.
 * `delayMs` lets a test hold the response open so two requests overlap. */
function makeAdInsertionServer(
  delayMs = 0
): Promise<{ origin: string; server: http.Server; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const lang = req.headers["accept-language"];
      hits.push(String(lang));
      if (!lang || lang === "*") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const send = () => {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(Buffer.from("ID3-FAKE-EPISODE-AUDIO"));
      };
      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ origin: `http://127.0.0.1:${port}`, server, hits });
    });
    server.on("error", reject);
  });
}

function seedEpisode(db: TestDb, enclosureUrl: string): { feedId: number; episodeId: number } {
  const feedId = 4242;
  db.prepare(
    `INSERT INTO podcast_subscriptions (feed_id, title, feed_url, source, auto_count)
     VALUES (?, 'The News Agents', 'https://feeds.captivate.fm/the-news-agents/', 'rss', 5)`
  ).run(feedId);
  const subId = db.prepare("SELECT id FROM podcast_subscriptions WHERE feed_id = ?").get(feedId) as { id: number };
  const info = db
    .prepare(
      `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
       VALUES (?, 'guid-1', 'Latest Episode', ?, 'failed')`
    )
    .run(subId.id, enclosureUrl);
  return { feedId, episodeId: Number(info.lastInsertRowid) };
}

describe.skipIf(!canRunDbTests)("podcast download — Accept-Language regression", () => {
  let db: TestDb;
  let srv: Awaited<ReturnType<typeof makeAdInsertionServer>>;

  beforeEach(async () => {
    _testUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-pod-dl-"));
    db = createTestDb();
    srv = await makeAdInsertionServer();
  });

  afterEach(async () => {
    closeDb(db);
    await new Promise<void>((r) => srv.server.close(() => r()));
    try { fs.rmSync(_testUserData, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it("downloads an episode whose CDN 404s on a wildcard Accept-Language", async () => {
    const enclosure = `${srv.origin}/episode/abc.mp3?aw_0_1st.showid=xyz`;
    const { feedId, episodeId } = seedEpisode(db, enclosure);

    const result = await downloadEpisode(db, episodeId, feedId);

    // The fix: a concrete Accept-Language was sent, so the CDN served the file.
    expect(srv.hits.every((h) => h !== "*" && h !== "undefined")).toBe(true);
    expect("localPath" in result).toBe(true);

    const row = db
      .prepare("SELECT download_state, local_path, file_size, download_error FROM podcast_episodes WHERE id = ?")
      .get(episodeId) as { download_state: string; local_path: string; file_size: number; download_error: string | null };
    expect(row.download_state).toBe("ready");
    expect(row.download_error).toBeNull();
    expect(fs.existsSync(row.local_path)).toBe(true);
    expect(fs.readFileSync(row.local_path).toString()).toBe("ID3-FAKE-EPISODE-AUDIO");
    expect(row.file_size).toBeGreaterThan(0);
  });

  it("two concurrent downloads of the same episode both succeed (no clobber to failed)", async () => {
    // Reproduces the "only one episode downloaded, the rest failed" report:
    // a manual "Download now" racing the auto-refresh scheduler downloaded the
    // same episode twice into the same temp file. One won the rename; the other
    // hit ENOENT and overwrote the 'ready' row with 'failed'.
    await new Promise<void>((r) => srv.server.close(() => r()));
    srv = await makeAdInsertionServer(150); // hold responses open so calls overlap

    const enclosure = `${srv.origin}/episode/abc.mp3?aw_0_1st.showid=xyz`;
    const { feedId, episodeId } = seedEpisode(db, enclosure);

    const [a, b] = await Promise.all([
      downloadEpisode(db, episodeId, feedId),
      downloadEpisode(db, episodeId, feedId),
    ]);

    expect("localPath" in a).toBe(true);
    expect("localPath" in b).toBe(true);

    // De-duped: the second concurrent call awaited the first, so the CDN was hit once.
    expect(srv.hits.length).toBe(1);

    const row = db
      .prepare("SELECT download_state, local_path, download_error FROM podcast_episodes WHERE id = ?")
      .get(episodeId) as { download_state: string; local_path: string; download_error: string | null };
    expect(row.download_state).toBe("ready");
    expect(row.download_error).toBeNull();
    expect(fs.existsSync(row.local_path)).toBe(true);
  });
});
