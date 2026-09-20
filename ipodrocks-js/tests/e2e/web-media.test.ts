/**
 * Playwright E2E — `/api/media/:token`, the web-mode replacement for the
 * `media://` scheme.
 *
 * Two things are being pinned, and they are separate gates on purpose:
 *
 * - **Range support.** Every browser media element seeks by asking for byte
 *   ranges; a route that only ever serves 200 with the whole body makes
 *   scrubbing impossible on anything larger than a buffer.
 * - **Containment.** A token is a capability minted by the server, but the
 *   path inside it is checked again against `isServableMediaPath()` — the same
 *   function the Electron protocol handler calls. Neither gate alone is enough:
 *   the signature stops a forged URL, the path check stops a *genuine* token
 *   from ever having been mintable for `/etc/passwd`.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

const BODY = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

let seedDir: string;
let audioPath: string;

test.beforeAll(() => {
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-media-"));
  audioPath = path.join(seedDir, "range-probe.mp3");
  fs.writeFileSync(audioPath, BODY);
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
  filePath: string
): Promise<string> {
  const prepared = await invoke<{ url: string; strategy: string }>(
    request,
    "player:prepare",
    // `.mp3` maps to a native codec, so no transcode runs and the URL points
    // straight at this file.
    { id: 1, path: filePath, codec: "MP3" }
  );
  expect(prepared.url).toMatch(/^\/api\/media\//);
  return prepared.url;
}

test("a prepared track is served whole, and by range", async ({ request }) => {
  const url = await mediaUrlFor(request, audioPath);

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
  const url = await mediaUrlFor(request, audioPath);

  const forged = await request.get("/api/media/not-a-token");
  expect(forged.status()).toBe(403);

  // Flip one character of the signature. The HMAC is checked before the
  // payload is parsed, so this never reaches JSON.parse.
  const tampered = url.slice(0, -1) + (url.endsWith("A") ? "B" : "A");
  const res = await request.get(tampered);
  expect(res.status()).toBe(403);
});

test("the route refuses a path that is not servable media", async ({ request }) => {
  // A token for a path outside the three allowed shapes cannot be minted
  // through any channel, so the containment gate is exercised directly: a
  // token for a real, readable, non-media file must still be refused.
  const textPath = path.join(seedDir, "notes.txt");
  fs.writeFileSync(textPath, "not media");

  const prepared = await invoke<{ url?: string; error?: string }>(
    request,
    "player:prepare",
    { id: 2, path: textPath, codec: "MP3" }
  );
  // `player:prepare` will happily mint a URL — it trusts its caller — which is
  // exactly why the route re-checks rather than trusting the token alone.
  if (prepared.url) {
    const res = await request.get(prepared.url);
    expect(res.status()).toBe(403);
  }
});

test("media is refused to a different session", async ({ request, browser }) => {
  const url = await mediaUrlFor(request, audioPath);

  // A second, signed-in-as-nobody context. The token carries the issuing
  // session id, so replaying the URL from anywhere else gets nothing — which
  // matters because the player's temp directory is one directory for the whole
  // server.
  const other = await browser.newContext();
  const res = await other.request.get(url);
  expect([401, 403]).toContain(res.status());
  await other.close();
});
