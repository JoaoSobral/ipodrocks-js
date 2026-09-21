/**
 * Playwright E2E — `/api/media/:token`, the web-mode replacement for the
 * `media://` scheme.
 *
 * Three things are being pinned, and they are separate gates on purpose:
 *
 * - **Range support.** Every browser media element seeks by asking for byte
 *   ranges; a route that only ever serves 200 with the whole body makes
 *   scrubbing impossible on anything larger than a buffer.
 * - **Containment.** A token is a capability minted by the server, but the
 *   path inside it is checked again against `isServableMediaPath()` — the same
 *   function the Electron protocol handler calls. Neither gate alone is enough:
 *   the signature stops a forged URL, the path check stops a *genuine* token
 *   from ever having been mintable for `/etc/passwd`.
 * - **Where the path comes from.** `player:prepare` takes the track *id* and
 *   reads `path` off the row. It used to take the client's `track.path`, which
 *   over the web meant an allowlisted guest could mint a media token for any
 *   file on the server with an audio extension — `isServableMediaPath()`'s
 *   middle arm is an extension test with no containment — and could send
 *   `ffmpeg -i` at a URL of their choosing on the transcode branch. That is
 *   the invariant the route's own comment depends on: "the token alone would
 *   be enough only for as long as nobody ever mints one from a path that came
 *   in over IPC".
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

const BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

interface TrackRow {
  id: number;
  path: string;
}

let seedDir: string;
let audioPath: string;
let trackId: number;

test.beforeAll(async ({ request }) => {
  await signIn(request);

  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-media-"));
  audioPath = path.join(seedDir, "range-probe.mp3");
  fs.writeFileSync(audioPath, BODY);

  // The track has to be a real library row now, because that row is where the
  // played path comes from.
  await invoke(request, "library:addFolder", {
    name: "WebMediaLib",
    path: seedDir,
    contentType: "music",
  });
  await invoke(request, "library:scan", {
    folders: [{ name: "WebMediaLib", path: seedDir, contentType: "music" }],
  });

  const tracks = await invoke<TrackRow[]>(request, "library:getTracks", {
    limit: 500,
  });
  const seeded = tracks.find((t) => t.path === audioPath);
  if (!seeded) throw new Error(`Seeded track not found in library: ${audioPath}`);
  trackId = seeded.id;
});

test.afterAll(() => {
  try {
    fs.rmSync(seedDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test.beforeEach(async ({ request }) => {
  await signIn(request);
});

/** Mints a real token the way the player does, through `player:prepare`. */
async function mediaUrlFor(
  request: import("@playwright/test").APIRequestContext,
  id: number
): Promise<string> {
  const prepared = await invoke<{ url: string; strategy: string }>(
    request,
    "player:prepare",
    // `.mp3` maps to a native codec, so no transcode runs and the URL points
    // straight at the file the row names.
    { id }
  );
  expect(prepared.url).toMatch(/^\/api\/media\//);
  return prepared.url;
}

test("a prepared track is served whole, and by range", async ({ request }) => {
  const url = await mediaUrlFor(request, trackId);

  const whole = await request.get(url);
  expect(whole.status()).toBe(200);
  expect(whole.headers()["accept-ranges"]).toBe("bytes");
  expect(whole.headers()["content-type"]).toBe("audio/mpeg");
  expect(Buffer.from(await whole.body())).toEqual(BODY);

  const ranged = await request.get(url, { headers: { Range: "bytes=5-9" } });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()["content-range"]).toBe(`bytes 5-9/${BODY.length}`);
  expect(Buffer.from(await ranged.body()).toString()).toBe("56789");

  // `bytes=-N` — the suffix form a media element uses to read a trailing tag.
  const suffix = await request.get(url, { headers: { Range: "bytes=-4" } });
  expect(suffix.status()).toBe(206);
  expect(Buffer.from(await suffix.body()).toString()).toBe("wxyz");

  // Open-ended, which is what a seek actually sends.
  const openEnded = await request.get(url, { headers: { Range: "bytes=30-" } });
  expect(openEnded.status()).toBe(206);
  expect(Buffer.from(await openEnded.body()).toString()).toBe("uvwxyz");

  const past = await request.get(url, { headers: { Range: "bytes=999-" } });
  expect(past.status()).toBe(416);
  expect(past.headers()["content-range"]).toBe(`bytes */${BODY.length}`);
});

test("a forged or tampered token is refused", async ({ request }) => {
  const url = await mediaUrlFor(request, trackId);

  const forged = await request.get("/api/media/not-a-token");
  expect(forged.status()).toBe(403);

  // Flip one character of the signature. The HMAC is checked before the
  // payload is parsed, so this never reaches JSON.parse.
  const tampered = url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");
  const res = await request.get(tampered);
  expect(res.status()).toBe(403);
});

test("player:prepare ignores a path the client supplies", async ({ request }) => {
  // The attack this closes: a readable file on the server, with an audio
  // extension, that no library folder contains. `isServableMediaPath()` would
  // serve it happily — its middle arm is `isAudioFilePath()` and nothing else
  // — so the only thing standing between a signed-in guest and it is that no
  // token can be minted for it.
  const outside = path.join(os.tmpdir(), `ipr-e2e-not-in-library-${Date.now()}.mp3`);
  fs.writeFileSync(outside, "definitely not yours");
  try {
    // A path smuggled in alongside a *valid* id must not be honoured: the row
    // wins, so this plays the seeded track and not the planted file.
    const hijack = await invoke<{ url?: string; error?: string }>(
      request,
      "player:prepare",
      { id: trackId, path: outside, codec: "MP3" }
    );
    expect(hijack.error).toBeUndefined();
    const served = await request.get(hijack.url!);
    expect(served.status()).toBe(200);
    expect(Buffer.from(await served.body())).toEqual(BODY);

    // And an id that is not in the library mints nothing at all, rather than
    // falling back to whatever path came with it.
    const bogus = await invoke<{ url?: string; error?: string }>(
      request,
      "player:prepare",
      { id: 999999, path: outside, codec: "MP3" }
    );
    expect(bogus.url).toBeUndefined();
    expect(bogus.error).toBeTruthy();
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("player:prepare will not drive ffmpeg at a URL", async ({ request }) => {
  // `forceTranscode` selects the branch that runs `ffmpeg -i <path>`, and
  // ffmpeg resolves a top-level `-i` as a URL with no protocol allowlist —
  // `http:`, `tcp:`, `concat:` all work. With the path coming off the row
  // there is nothing for the client to point it at, so the call is refused
  // before any process is spawned.
  const res = await invoke<{ url?: string; error?: string }>(
    request,
    "player:prepare",
    { id: 0, path: "http://127.0.0.1:1/ssrf.mp3", codec: "MPC" },
    true
  );
  expect(res.url).toBeUndefined();
  expect(res.error).toBeTruthy();
});

test("media is refused to a different session", async ({ request, browser }) => {
  const url = await mediaUrlFor(request, trackId);

  // A second, signed-in-as-nobody context. The token carries the issuing
  // session id, so replaying the URL from anywhere else gets nothing — which
  // matters because the player's temp directory is one directory for the whole
  // server.
  const other = await browser.newContext();
  const res = await other.request.get(url);
  expect([401, 403]).toContain(res.status());
  await other.close();
});
