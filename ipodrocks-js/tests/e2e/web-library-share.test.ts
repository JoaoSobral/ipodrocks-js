/**
 * Playwright E2E — library sharing, the sharer's side, over the real daemon.
 *
 * The owner creates a share through `/api/invoke` exactly as the Settings card
 * will, and this spec then plays the *friend's server*: it redeems the invite
 * at `/api/federation/pair` with an Ed25519 key of its own and signs every
 * later request with it. The signing is re-implemented here from the wire
 * format rather than imported, so the spec is an independent check of what
 * the daemon accepts — a round trip through our own signer is not a format
 * test.
 *
 * What it pins, over a real listener with the real middleware stack in front
 * (origin guard, limiters, the SPA fallback):
 * - the router is mounted outside `requireAuth` and answers a peer with no
 *   session at all;
 * - the invite works once;
 * - an unsigned request and a request signed by the wrong key get the same
 *   404, and neither is countersigned;
 * - a signed request gets the share's catalogue, countersigned by the key the
 *   pairing handed over, with no server path in it;
 * - media streams with Range;
 * - revoking takes effect on the very next request.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { invoke, setMpcReminderDisabled, signIn, WEB_ORIGIN } from "./web-harness";

test.describe.configure({ mode: "serial" });

const FOLDER_NAME = "WebShareLib";

let seedDir: string;
let folderId: number;
let shareId: string;
let inviteLink: string;
let sharerKey: crypto.KeyObject;
const peer = crypto.generateKeyPairSync("ed25519");
const peerPublic = peer.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const stranger = crypto.generateKeyPairSync("ed25519");

/** A peer has no cookie jar: a fresh context per call, never the owner's. */
async function peerContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
}

function sign(urlPath: string, key: crypto.KeyObject = peer.privateKey) {
  const created = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("base64url");
  const canonical = ["ipodrocks-federation-v1", "GET", urlPath, shareId, created, nonce].join("\n");
  return {
    nonce,
    headers: {
      "x-ipodrocks-share": shareId,
      "x-ipodrocks-created": created,
      "x-ipodrocks-nonce": nonce,
      "x-ipodrocks-signature": crypto.sign(null, Buffer.from(canonical), key).toString("base64url"),
    },
  };
}

function countersigned(nonce: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const msg = ["ipodrocks-federation-response-v1", shareId, nonce].join("\n");
  return crypto.verify(null, Buffer.from(msg), sharerKey, Buffer.from(sig, "base64url"));
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  seedDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-share-"));
  fs.mkdirSync(path.join(seedDir, "Band", "Record"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "Band", "Record", "01 Shared.mp3"), Buffer.alloc(2048, 3));

  await invoke(request, "library:addFolder", { name: FOLDER_NAME, path: seedDir, contentType: "music" });
  await invoke(request, "library:scan", {
    folders: [{ name: FOLDER_NAME, path: seedDir, contentType: "music" }],
  });
  const folders = await invoke<{ id: number; path: string }[]>(request, "library:getFolders");
  folderId = folders.find((f) => f.path === seedDir)!.id;
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  if (shareId) await invoke(request, "share:delete", shareId);
  if (folderId) await invoke(request, "library:removeFolder", folderId);
  fs.rmSync(seedDir, { recursive: true, force: true });
});

test("the owner creates a share and gets a single-use invite link", async ({ request }) => {
  await signIn(request);
  const created = await invoke<{ share: { id: string; status: string }; inviteLink: string }>(
    request,
    "share:create",
    { label: "E2E friend", folderIds: [folderId], playlistIds: [] }
  );
  expect(created.share.status).toBe("pending");
  shareId = created.share.id;
  inviteLink = created.inviteLink;
  // The secret is in the fragment, so it never reaches a request log.
  expect(new URL(inviteLink).hash).toMatch(new RegExp(`^#share=${shareId}\\.`));
});

test("a peer server with no session pairs once", async () => {
  const code = new URL(inviteLink).hash.split(".").slice(1).join(".");
  const ctx = await peerContext();
  const res = await ctx.post("/api/federation/pair", {
    data: { shareId, code, publicKey: peerPublic, peerName: "E2E peer" },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { sharerPublicKey: string };
  sharerKey = crypto.createPublicKey({
    key: Buffer.from(body.sharerPublicKey, "base64url"),
    format: "der",
    type: "spki",
  });

  const again = await ctx.post("/api/federation/pair", {
    data: { shareId, code, publicKey: peerPublic },
  });
  expect(again.status()).toBe(404);
  await ctx.dispose();
});

test("unsigned and wrongly-signed requests get the same uncountersigned 404", async () => {
  const ctx = await peerContext();
  const url = "/api/federation/catalog";
  const unsigned = await ctx.get(url);
  const wrong = await ctx.get(url, { headers: sign(url, stranger.privateKey).headers });
  for (const res of [unsigned, wrong]) {
    expect(res.status()).toBe(404);
    expect(res.headers()["x-ipodrocks-response-sig"]).toBeUndefined();
  }
  expect(await wrong.text()).toBe(await unsigned.text());
  await ctx.dispose();
});

test("a signed request gets the countersigned catalogue and the audio", async () => {
  const ctx = await peerContext();
  const url = "/api/federation/catalog";
  const { headers, nonce } = sign(url);
  const res = await ctx.get(url, { headers });
  expect(res.status()).toBe(200);
  expect(countersigned(nonce, res.headers()["x-ipodrocks-response-sig"])).toBe(true);

  const cat = (await res.json()) as { items: { ref: string; relPath: string; title: string | null }[] };
  expect(cat.items).toHaveLength(1);
  expect(JSON.stringify(cat)).not.toContain(seedDir);
  expect(cat.items[0].relPath).toBe("Band/Record/01 Shared.mp3");

  const mediaUrl = `/api/federation/media/${cat.items[0].ref}`;
  const media = await ctx.get(mediaUrl, { headers: { ...sign(mediaUrl).headers, range: "bytes=0-99" } });
  expect(media.status()).toBe(206);
  expect((await media.body()).length).toBe(100);
  await ctx.dispose();
});

test("revoking takes effect on the very next request", async ({ request }) => {
  await signIn(request);
  await invoke(request, "share:revoke", shareId);
  const ctx = await peerContext();
  const url = "/api/federation/catalog";
  const res = await ctx.get(url, { headers: sign(url).headers });
  expect(res.status()).toBe(410);
  await ctx.dispose();

  const list = await invoke<{ shares: { id: string; status: string }[] }>(request, "share:list");
  expect(list.shares.find((s) => s.id === shareId)?.status).toBe("revoked");
});

test("the Settings → Sharing card creates and revokes a share", async ({ page }) => {
  await signIn(page.request);
  const previous = await setMpcReminderDisabled(page.request, true);
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: /^Remote/ }).click();
    const card = page.getByTestId("sharing-card");
    await card.waitFor();

    await page.getByTestId("share-new").click();
    await page.getByTestId("share-label").fill("Rendered friend");
    await page.getByTestId(`share-folder-${folderId}`).check();
    await page.getByTestId("share-create").click();

    const link = page.getByTestId("share-invite-link");
    await expect(link).toHaveValue(/#share=[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{32}$/);
    const id = /#share=([^.]+)\./.exec(await link.inputValue())![1];

    const row = page.getByTestId(`share-row-${id}`);
    await expect(row).toContainText("Waiting for the invite to be used");
    await page.getByTestId(`share-revoke-${id}`).click();
    await expect(row).toContainText("Revoked");
    await invoke(page.request, "share:delete", id);
  } finally {
    await setMpcReminderDisabled(page.request, previous);
  }
});
