/**
 * Playwright E2E — a remote library, between two real daemons.
 *
 * The `web` project's long-lived daemon is the **sharer** (Ana's server). This
 * spec boots a second daemon of its own — fresh data directory, port 8783 — as
 * the **recipient** (Pedro's server), the way `web-owner-reset` boots one.
 * Both run on loopback, which the peer policy refuses for any real peer; the
 * recipient alone gets `IPODROCKS_FEDERATION_ALLOW_LOOPBACK=1`, the test-only
 * switch that is honoured only for a peer added with the LAN flag.
 *
 * End to end, over real HTTP, real signatures and real countersignatures:
 *   share on A → paste the invite on B → B's catalogue lists the track →
 *   B streams it with Range through its own proxy → "Keep offline" makes it
 *   an ordinary library track on B → the rendered Library panel shows the
 *   remote library → A revokes → B's next refresh purges the copy and the
 *   catalogue.
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

const PORT = 8783;
const RECIPIENT = `http://127.0.0.1:${PORT}`;
const DAEMON = path.resolve(__dirname, "..", "..", "dist", "main", "server", "daemon.js");
const OWNER = "remote-recipient-owner";
const PASSWORD = "recipient-correct-horse-battery";

/** A minimal MP3: one MPEG-1 Layer III frame header and padding. */
const MP3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(6000, 0)]);

let sharerDir: string;
let recipientDir: string;
let daemon: ChildProcess | null = null;
let log = "";
let recipient: APIRequestContext;
let folderId: number;
let shareId: string;
let inviteLink: string;
let remoteId: number;

async function boot(): Promise<void> {
  daemon = spawn(process.execPath, [DAEMON], {
    env: {
      ...process.env,
      IPODROCKS_DATA_DIR: recipientDir,
      IPODROCKS_SERVER_HOST: "127.0.0.1",
      IPODROCKS_SERVER_PORT: String(PORT),
      IPODROCKS_SESSION_SECRET: "e2e-remote-recipient-secret",
      IPODROCKS_DISABLE_UPDATE_CHECK: "1",
      IPODROCKS_FEDERATION_ALLOW_LOOPBACK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  daemon.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${RECIPIENT}/api/auth/status`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`recipient daemon did not start:\n${log}`);
}

function recipientClaimToken(): string {
  const db = new Database(path.join(recipientDir, "ipodrocks-server.db"), { readonly: true });
  try {
    return (db.prepare("SELECT value FROM server_settings WHERE key = 'owner_claim_token'").get() as {
      value: string;
    }).value;
  } finally {
    db.close();
  }
}

/** `invoke` against the recipient, with its own cookie jar. */
async function onRecipient<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(recipient, channel, ...args);
}

test.beforeAll(async ({ request }) => {
  // The sharer: a folder with one real (sniffable) MP3 in it.
  await signIn(request);
  sharerDir = fs.mkdtempSync(path.join(os.homedir(), ".ipr-e2e-remote-share-"));
  fs.mkdirSync(path.join(sharerDir, "Ana Band", "Ana Album"), { recursive: true });
  fs.writeFileSync(path.join(sharerDir, "Ana Band", "Ana Album", "01 Shared Song.mp3"), MP3);
  await invoke(request, "library:addFolder", { name: "AnaShared", path: sharerDir, contentType: "music" });
  await invoke(request, "library:scan", { folders: [{ name: "AnaShared", path: sharerDir, contentType: "music" }] });
  const folders = await invoke<{ id: number; path: string }[]>(request, "library:getFolders");
  folderId = folders.find((f) => f.path === fs.realpathSync(sharerDir) || f.path === sharerDir)!.id;

  // The recipient: its own daemon, claimed by its own owner.
  recipientDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-e2e-remote-recipient-"));
  await boot();
  recipient = await playwrightRequest.newContext({ baseURL: RECIPIENT });
  const claimed = await recipient.post("/api/auth/local/claim", {
    data: { username: OWNER, password: PASSWORD, claimToken: recipientClaimToken() },
  });
  expect(claimed.ok(), await claimed.text()).toBe(true);
});

test.afterAll(async ({ request }) => {
  await recipient?.dispose();
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((r) => daemon!.once("exit", r));
    daemon.kill("SIGTERM");
    await exited;
  }
  await signIn(request);
  if (shareId) await invoke(request, "share:delete", shareId);
  if (folderId) await invoke(request, "library:removeFolder", folderId);
  fs.rmSync(sharerDir, { recursive: true, force: true });
  fs.rmSync(recipientDir, { recursive: true, force: true });
});

test("the sharer creates an invite", async ({ request }) => {
  await signIn(request);
  const created = await invoke<{ share: { id: string }; inviteLink: string }>(request, "share:create", {
    label: "Pedro",
    folderIds: [folderId],
    playlistIds: [],
  });
  shareId = created.share.id;
  inviteLink = created.inviteLink;
});

test("the recipient refuses the invite without the LAN flag, then pairs with it", async () => {
  // Plain http on loopback: refused as an internet peer, and the invite is
  // not spent by the refusal.
  const refused = await onRecipient<{ error?: string }>("remote:add", { inviteLink, lan: false });
  expect(refused.error).toMatch(/HTTPS|LAN|private/i);

  const added = await onRecipient<{ library: { id: number; trackCount: number; status: string } }>("remote:add", {
    inviteLink,
    name: "Ana",
    lan: true,
  });
  expect(added.library).toMatchObject({ trackCount: 1, status: "active" });
  remoteId = added.library.id;

  const again = await onRecipient<{ error?: string }>("remote:add", { inviteLink, lan: true });
  expect(again.error).toBeTruthy();
});

test("the recipient browses and streams the track through its own server", async () => {
  const listed = await onRecipient<{ tracks: { id: number; title: string | null; cached: boolean }[] }>(
    "remote:tracks",
    remoteId,
    {}
  );
  expect(listed.tracks).toHaveLength(1);
  expect(listed.tracks[0].cached).toBe(false);

  const { url } = await onRecipient<{ url: string }>("remote:streamUrl", listed.tracks[0].id);
  expect(url).toMatch(/^\/api\/remote-media\//);
  const part = await recipient.get(url, { headers: { range: "bytes=0-99" } });
  expect(part.status()).toBe(206);
  const body = await part.body();
  expect(body.length).toBe(100);
  expect(body.subarray(0, 4)).toEqual(MP3.subarray(0, 4));
  // The type is ours, from the catalogue path — never the peer's.
  expect(part.headers()["content-type"]).toBe("audio/mpeg");

  // A token is bound to the session that minted it.
  const stranger = await playwrightRequest.newContext({ baseURL: RECIPIENT });
  expect((await stranger.get(url)).status()).toBe(401);
  await stranger.dispose();
});

test("keeping it offline makes it an ordinary library track", async () => {
  const listed = await onRecipient<{ tracks: { id: number }[] }>("remote:tracks", remoteId, {});
  const kept = await onRecipient<{ downloaded: number; failed: number; errors: string[] }>(
    "remote:keepOffline",
    remoteId,
    [listed.tracks[0].id]
  );
  expect(kept, JSON.stringify(kept)).toMatchObject({ downloaded: 1, failed: 0 });

  const tracks = await onRecipient<{ path: string }[]>("library:getTracks", { limit: 500 });
  const local = tracks.filter((t) => t.path.includes(`remote-cache${path.sep}${remoteId}`));
  expect(local).toHaveLength(1);
  expect(fs.readFileSync(local[0].path)).toEqual(MP3);

  const libs = await onRecipient<{ libraries: { cachedCount: number }[] }>("remote:list");
  expect(libs.libraries[0].cachedCount).toBe(1);
});

test("the Library panel renders the remote library", async ({ page }) => {
  await onRecipient("app:setMpcRemindDisabled", true);
  const state = await recipient.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto(RECIPIENT);
  await page.getByRole("button", { name: "Library" }).first().click();
  const row = page.getByTestId(`remote-library-${remoteId}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Ana");
  await expect(row).toContainText("1 offline");

  // "+ Add Remote Library" sits in the top bar beside "+ Add Folder" and
  // opens the add dialog.
  const addFolder = page.getByRole("button", { name: "+ Add Folder" });
  const addRemote = page.getByTestId("remote-add-open");
  await expect(addRemote).toHaveText("+ Add Remote Library");
  await expect(addRemote.locator("xpath=..")).toContainText("+ Add Folder");
  await expect(addFolder).toBeVisible();
  await addRemote.click();
  await expect(page.getByTestId("remote-add-form")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("remote-add-form")).toBeHidden();
});

test("revoking on the sharer purges the copy on the recipient", async ({ request }) => {
  await signIn(request);
  await invoke(request, "share:revoke", shareId);

  const refreshed = await onRecipient<{ error?: string }>("remote:refresh", remoteId);
  expect(refreshed.error).toMatch(/stopped sharing/);
  const libs = await onRecipient<{ libraries: { status: string; cachedCount: number; trackCount: number }[] }>(
    "remote:list"
  );
  expect(libs.libraries[0]).toMatchObject({ status: "revoked", cachedCount: 0, trackCount: 0 });

  const tracks = await onRecipient<{ path: string }[]>("library:getTracks", { limit: 500 });
  expect(tracks.filter((t) => t.path.includes("remote-cache"))).toHaveLength(0);
  expect(fs.existsSync(path.join(fs.realpathSync(recipientDir), "remote-cache", String(remoteId)))).toBe(false);
});
