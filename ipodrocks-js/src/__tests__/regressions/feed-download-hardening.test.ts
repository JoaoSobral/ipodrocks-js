/**
 * @vitest-environment node
 *
 * Regressions from the 2026-09-28 security findings against the podcast and
 * audiobook fetch paths. Everything here is reachable by any allowlisted web
 * user — `podcast:discoverFeeds`, `podcast:previewFeed`,
 * `podcast:subscribeByUrl`, `audiobook:subscribe` — and by any hostile public
 * feed the owner subscribes to.
 *
 * 1. Feed discovery ran two backtracking regexes over the caller's page:
 *    quadratic, on the daemon's only thread.
 * 2. Feed bodies were buffered with `res.text()` — no cap, and transparent
 *    decompression means the wire size bounds nothing — then parsed with
 *    DOCTYPE entity expansion on.
 * 3. Enclosure downloads had no time bound: a trickling server wedged the
 *    serial refresh and any device sync downloading a chapter.
 * 4. The enclosure's bytes and extension were whatever the feed said. An HLS
 *    playlist stored as `.m3u8` (or `.mp3`) is demuxed by ffmpeg, which then
 *    opens the server file each segment line names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import { createTestDb, closeDb, canRunDbTests, type TestDb } from "../harness";
import { setPrivateFetchAllowed } from "@main/utils/safe-fetch";
import { setDownloadLimitsForTests, readBodyCapped } from "@main/utils/capped-stream";
import {
  enclosureExtension,
  provisionalEnclosureExtension,
  sniffAudioContainer,
  sniffAudioFile,
} from "@main/utils/audio-sniff";
import {
  discoverFeeds,
  extractLinkAttributes,
  fetchAndParseFeed,
  findLinkTags,
  MAX_FEED_BYTES,
} from "@main/podcasts/podcast-feed-import";

// downloadEpisode/downloadChapter → storage → the host's userData.
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
import { downloadChapter } from "@main/audiobooks/audiobook-downloader";
import { getChapterDir } from "@main/audiobooks/audiobook-storage";

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((r) => server.close(() => r()));
}

/** A real MPEG-1 Layer III frame header, then filler. */
const MP3_BYTES = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(2048, 0x55)]);
const HLS_PLAYLIST = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n/srv/private/album/01.mp3\n#EXT-X-ENDLIST\n";

/** A well-formed ID3v2.4 header of `size` bytes (syncsafe), then padding. */
function id3(size: number): Buffer {
  const h = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([h, Buffer.alloc(size, 0)]);
}

// ---------------------------------------------------------------------------
// 1. Discovery is linear in the page, whatever the page holds.
// ---------------------------------------------------------------------------
describe("HTML feed discovery is linear", () => {
  it("a 1 MB <link aaaa…> tag is handled in well under a second", () => {
    const html = `<link ${"a".repeat(1_000_000)}>`;
    const t0 = performance.now();
    const tags = findLinkTags(html);
    for (const t of tags) extractLinkAttributes(t);
    // And the attribute tokenizer on its own, unbounded by the tag cap.
    extractLinkAttributes("a".repeat(1_000_000));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("a body of repeated `<link` with no `>` is handled in well under a second", () => {
    const html = "<link ".repeat(200_000);
    const t0 = performance.now();
    expect(findLinkTags(html)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("repeated `<link` before one far-away `>` does not rescan", () => {
    const html = "<link ".repeat(200_000) + ">";
    const t0 = performance.now();
    findLinkTags(html);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("still finds real feed links, in the spellings pages use", () => {
    const html = `<html><head>
      <LINK REL="alternate" TYPE="application/rss+xml" title='Show "One"' href="/feed.xml">
      <link rel=alternate type=application/atom+xml href=https://x.example/atom />
      <linkfoo rel="alternate" type="application/rss+xml" href="/nope">
      <link rel="stylesheet" href="/s.css">
    </head></html>`;
    const attrs = findLinkTags(html).map(extractLinkAttributes);
    expect(attrs).toHaveLength(3);
    expect(attrs[0]).toMatchObject({ rel: "alternate", type: "application/rss+xml", title: 'Show "One"', href: "/feed.xml" });
    expect(attrs[1]).toMatchObject({ rel: "alternate", type: "application/atom+xml", href: "https://x.example/atom" });
  });
});

// ---------------------------------------------------------------------------
// 2. Feed and discovery bodies are capped in decoded bytes; no DOCTYPE entity
//    is ever expanded.
// ---------------------------------------------------------------------------
describe("feed bodies are bounded before they are parsed", () => {
  let srv: Awaited<ReturnType<typeof listen>>;
  let body: Buffer = Buffer.alloc(0);
  let headers: Record<string, string> = {};

  beforeEach(async () => {
    setPrivateFetchAllowed(true);
    srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml", ...headers });
      res.end(body);
    });
  });
  afterEach(async () => {
    setPrivateFetchAllowed(false);
    headers = {};
    await close(srv.server);
  });

  const feedWithTitle = (title: string, extra = "") => `<?xml version="1.0"?>${extra}
<rss version="2.0"><channel><title>${title}</title>
<description><![CDATA[a &amp; b <i>x</i>]]></description>
<item><title>Ep</title><enclosure url="https://e.example/a.mp3?x=1&amp;y=2" length="1"/></item>
</channel></rss>`;

  it("still decodes the predefined entities and leaves CDATA verbatim", async () => {
    body = Buffer.from(feedWithTitle("Tom &amp; Jerry &lt;3 &quot;q&quot; &apos;a&apos;"));
    const feed = await fetchAndParseFeed(`${srv.origin}/feed.xml`);
    expect(feed.title).toBe(`Tom & Jerry <3 "q" 'a'`);
    expect(feed.description).toBe("a &amp; b <i>x</i>");
    expect(feed.episodes[0].enclosureUrl).toBe("https://e.example/a.mp3?x=1&y=2");
  });

  it("never expands a DOCTYPE-declared entity", async () => {
    const big = "X".repeat(5000);
    const refs = "&e;".repeat(2000); // ~10 MB if expanded, per node
    body = Buffer.from(feedWithTitle(`T ${refs}`, `<!DOCTYPE rss [<!ENTITY e "${big}">]>`));
    const feed = await fetchAndParseFeed(`${srv.origin}/feed.xml`);
    expect(feed.title.length).toBeLessThan(10_000);
    expect(feed.title).toContain("&e;");
    expect(feed.title).not.toContain("XXXX");
  });

  it("rejects a feed whose body exceeds the cap", async () => {
    body = Buffer.concat([Buffer.from(feedWithTitle("Big")), Buffer.alloc(MAX_FEED_BYTES, 0x20)]);
    await expect(fetchAndParseFeed(`${srv.origin}/feed.xml`)).rejects.toThrow(/exceeded the maximum size/);
  });

  it("counts decoded bytes: a small gzip that inflates past the cap is rejected", async () => {
    const inflated = Buffer.concat([Buffer.from(feedWithTitle("Bomb")), Buffer.alloc(MAX_FEED_BYTES + 1024, 0x20)]);
    body = zlib.gzipSync(inflated);
    headers = { "content-encoding": "gzip" };
    expect(body.length).toBeLessThan(1024 * 1024); // small on the wire
    await expect(fetchAndParseFeed(`${srv.origin}/feed.xml`)).rejects.toThrow(/exceeded the maximum size/);
  });

  it("truncates a huge discovery page instead of buffering it", async () => {
    headers = { "content-type": "text/html" };
    body = Buffer.concat([
      Buffer.from(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`),
      Buffer.alloc(8 * 1024 * 1024, 0x61),
    ]);
    const found = await discoverFeeds(`${srv.origin}/page`);
    expect(found.map((c) => c.feedUrl)).toEqual([`${srv.origin}/feed.xml`]);
  });

  it("readBodyCapped stops at the cap in both modes", async () => {
    const stream = () => new Response(Buffer.alloc(100_000, 1)).body;
    await expect(readBodyCapped(stream(), 1000)).rejects.toThrow(/exceeded/);
    expect((await readBodyCapped(stream(), 1000, "truncate")).length).toBe(1000);
    expect((await readBodyCapped(stream(), 200_000)).length).toBe(100_000);
  });
});

// ---------------------------------------------------------------------------
// 4. What an enclosure may be.
// ---------------------------------------------------------------------------
describe("enclosure content sniffing", () => {
  it("recognises the real containers", () => {
    const cases: [Buffer, string][] = [
      [MP3_BYTES, "mpeg"],
      [Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0]), "adts"],
      [Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0", "latin1"), "mp4"],
      [Buffer.from("OggS\0\x02\0\0", "latin1"), "ogg"],
      [Buffer.from("fLaC\0\0\0\x22", "latin1"), "flac"],
      [Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), "wav"],
      [Buffer.from("FORM\0\0\0\0AIFFCOMM", "latin1"), "aiff"],
      [Buffer.from("MPCK\0\0\0\0", "latin1"), "mpc"],
      [Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6]), "asf"],
    ];
    for (const [buf, want] of cases) expect(sniffAudioContainer(buf), want).toBe(want);
  });

  it("refuses playlists, markup and text", () => {
    for (const s of [HLS_PLAYLIST, "ffconcat version 1.0\nfile /etc/x.mp3\n", "<?xml version='1.0'?><MPD/>", "<!doctype html><script>", "hello"]) {
      expect(sniffAudioContainer(Buffer.from(s)), s.slice(0, 12)).toBeNull();
    }
    // A reserved MPEG header is not a frame.
    expect(sniffAudioContainer(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))).toBeNull();
  });

  it("judges what follows an ID3v2 tag, the way ffmpeg's probe does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-sniff-"));
    try {
      const write = (name: string, buf: Buffer) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, buf);
        return p;
      };
      expect(sniffAudioFile(write("a", Buffer.concat([id3(300), MP3_BYTES])))).toBe("mpeg");
      expect(sniffAudioFile(write("b", Buffer.concat([id3(40), id3(40), MP3_BYTES])))).toBe("mpeg");
      // ID3 + playlist: ffmpeg skips the tag and sees #EXTM3U.
      expect(sniffAudioFile(write("c", Buffer.concat([id3(64), Buffer.from(HLS_PLAYLIST)])))).toBeNull();
      // A tag with nothing after it is not audio.
      expect(sniffAudioFile(write("d", id3(64)))).toBeNull();
      // Leading NULs are skipped, text is not.
      expect(sniffAudioFile(write("e", Buffer.concat([Buffer.alloc(16), MP3_BYTES])))).toBe("mpeg");
      expect(sniffAudioFile(write("f", Buffer.concat([Buffer.from("#EXTM3U\n"), MP3_BYTES])))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the extension from a fixed table, never from the URL", () => {
    expect(provisionalEnclosureExtension("https://x/a.m3u8")).toBe(".mp3");
    expect(provisionalEnclosureExtension("https://x/a.html")).toBe(".mp3");
    expect(provisionalEnclosureExtension("https://x/a.M4B")).toBe(".m4b");
    expect(enclosureExtension("https://x/a.html", "mpeg")).toBe(".mp3");
    expect(enclosureExtension("https://x/a.mp3", "mp4")).toBe(".m4a"); // bytes win
    expect(enclosureExtension("https://x/book.m4b", "mp4")).toBe(".m4b");
    expect(enclosureExtension("https://x/a.js", "ogg")).toBe(".ogg");
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 through the real downloaders.
// ---------------------------------------------------------------------------
describe.skipIf(!canRunDbTests)("enclosure downloads", () => {
  let db: TestDb;
  let srv: Awaited<ReturnType<typeof listen>>;
  let route: (req: http.IncomingMessage, res: http.ServerResponse) => void = () => undefined;
  const timers = new Set<NodeJS.Timeout>();

  beforeEach(async () => {
    setPrivateFetchAllowed(true);
    // Windows shrunk so a stall is seen in milliseconds, not a minute.
    setDownloadLimitsForTests({ stallWindowMs: 250, minBytesPerWindow: 1024, maxDurationMs: 5000 });
    _testUserData = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-dl-harden-"));
    db = createTestDb();
    srv = await listen((req, res) => route(req, res));
  });

  afterEach(async () => {
    for (const t of timers) clearInterval(t);
    timers.clear();
    setPrivateFetchAllowed(false);
    setDownloadLimitsForTests(null);
    closeDb(db);
    await close(srv.server);
    try { fs.rmSync(_testUserData, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Headers, then one byte every 50 ms for ever. */
  const trickle = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.write(MP3_BYTES.subarray(0, 4));
    const t = setInterval(() => res.write("x"), 50);
    timers.add(t);
    res.on("close", () => clearInterval(t));
  };

  function seedEpisode(enclosureUrl: string): { feedId: number; episodeId: number } {
    const feedId = -777;
    db.prepare(
      `INSERT OR IGNORE INTO podcast_subscriptions (feed_id, title, feed_url, source, auto_count)
       VALUES (?, 'Hostile', 'https://hostile.example/feed', 'rss', 1)`
    ).run(feedId);
    const sub = db.prepare("SELECT id FROM podcast_subscriptions WHERE feed_id = ?").get(feedId) as { id: number };
    const info = db
      .prepare(
        `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
         VALUES (?, ?, 'Ep', ?, 'pending')`
      )
      .run(sub.id, `g-${Math.random()}`, enclosureUrl);
    return { feedId, episodeId: Number(info.lastInsertRowid) };
  }

  function seedChapter(enclosureUrl: string): number {
    db.prepare(
      `INSERT OR IGNORE INTO audiobook_subscriptions (librivox_id, title, rss_url)
       VALUES (4242, 'Book', 'https://hostile.example/book.rss')`
    ).run();
    const sub = db.prepare("SELECT id FROM audiobook_subscriptions WHERE librivox_id = 4242").get() as { id: number };
    const info = db
      .prepare(
        `INSERT INTO audiobook_chapters (subscription_id, guid, title, enclosure_url, download_state)
         VALUES (?, ?, 'Ch', ?, 'pending')`
      )
      .run(sub.id, `c-${Math.random()}`, enclosureUrl);
    return Number(info.lastInsertRowid);
  }

  const episodeRow = (id: number) =>
    db.prepare("SELECT download_state, local_path, download_error FROM podcast_episodes WHERE id = ?").get(id) as {
      download_state: string; local_path: string | null; download_error: string | null;
    };
  const chapterRow = (id: number) =>
    db.prepare("SELECT download_state, local_path, download_error FROM audiobook_chapters WHERE id = ?").get(id) as {
      download_state: string; local_path: string | null; download_error: string | null;
    };
  const leftovers = (p: string | null) =>
    p ? fs.readdirSync(path.dirname(p)).filter((f) => f.endsWith(".tmp")) : [];

  it("a trickling episode fails within the bound, leaves no temp file, and is marked failed", async () => {
    route = trickle;
    const { feedId, episodeId } = seedEpisode(`${srv.origin}/ep.mp3`);
    const t0 = Date.now();
    const result = await downloadEpisode(db, episodeId, feedId);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect("error" in result && result.error).toMatch(/stalled/i);
    const row = episodeRow(episodeId);
    expect(row.download_state).toBe("failed");
    expect(leftovers(row.local_path)).toEqual([]);
  });

  it("a trickling chapter fails the same way", async () => {
    route = trickle;
    const chapterId = seedChapter(`${srv.origin}/ch.mp3`);
    const result = await downloadChapter(db, chapterId);
    expect("error" in result && result.error).toMatch(/stalled/i);
    const row = chapterRow(chapterId);
    expect(row.download_state).toBe("failed");
    expect(leftovers(row.local_path)).toEqual([]);
  });

  it("a caller's signal (a device sync's cancel) ends a chapter download", async () => {
    // Fast enough that the stall guard never fires; only the cancel can end it.
    route = (_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.write(MP3_BYTES);
      const t = setInterval(() => res.write(Buffer.alloc(4096, 0x55)), 20);
      timers.add(t);
      res.on("close", () => clearInterval(t));
    };
    const chapterId = seedChapter(`${srv.origin}/ch.mp3`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("Sync cancelled")), 150);
    const result = await downloadChapter(db, chapterId, ac.signal);
    expect("error" in result && result.error).toBe("Sync cancelled");
    const row = chapterRow(chapterId);
    expect(row.download_state).toBe("failed");
    expect(leftovers(row.local_path)).toEqual([]);
  });

  it("an HLS playlist enclosure is refused and never reaches disk, whatever its extension", async () => {
    route = (_req, res) => res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(HLS_PLAYLIST);
    for (const name of ["ep.m3u8", "ep.mp3"]) {
      const { feedId, episodeId } = seedEpisode(`${srv.origin}/${name}`);
      const result = await downloadEpisode(db, episodeId, feedId);
      expect("error" in result && result.error, name).toMatch(/not a recognised audio format/);
      const row = episodeRow(episodeId);
      expect(row.download_state).toBe("failed");
      const dir = path.dirname(row.local_path!);
      expect(fs.readdirSync(dir), name).toEqual([]);
    }
  });

  it("stores real audio under an allowlisted extension even when the URL says .html", async () => {
    route = (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(MP3_BYTES);
    const { feedId, episodeId } = seedEpisode(`${srv.origin}/page.html`);
    const result = await downloadEpisode(db, episodeId, feedId);
    expect("localPath" in result).toBe(true);
    const row = episodeRow(episodeId);
    expect(row.download_state).toBe("ready");
    expect(path.extname(row.local_path!)).toBe(".mp3");
    expect(fs.readFileSync(row.local_path!).equals(MP3_BYTES)).toBe(true);
  });

  it("a non-audio file left by an older version is not handed out as ready", async () => {
    route = (_req, res) => res.writeHead(200).end(MP3_BYTES);
    const chapterId = seedChapter(`${srv.origin}/ch.mp3`);
    fs.mkdirSync(getChapterDir(4242), { recursive: true });
    const stale = path.join(getChapterDir(4242), "stale.m3u8");
    fs.writeFileSync(stale, HLS_PLAYLIST);
    db.prepare("UPDATE audiobook_chapters SET download_state = 'ready', local_path = ? WHERE id = ?").run(stale, chapterId);
    const result = await downloadChapter(db, chapterId);
    expect("localPath" in result && result.localPath).not.toBe(stale);
    expect(path.extname(chapterRow(chapterId).local_path!)).toBe(".mp3");
    expect(fs.existsSync(stale)).toBe(false);
  });
});
