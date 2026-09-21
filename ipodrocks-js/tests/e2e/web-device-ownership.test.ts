/**
 * Playwright E2E — a browser-held device belongs to the account that
 * registered it.
 *
 * `device-attach` names a device id over the already-authenticated socket, and
 * the only check used to be that the row says `transport = 'web'`. Every
 * allowlisted identity satisfies that for *every* web device, so the
 * per-device mutex CLAUDE.md describes — "a second attach of the same device
 * detaches the first" — was a takeover primitive rather than a safety
 * property:
 *
 * - the incumbent is evicted, so the real owner's player silently stops
 *   working and their next sync reports it as not connected;
 * - every later `RemoteDeviceFs` call is routed to the attacker's browser,
 *   and the one-shot `/api/device-io/pull` tokens are minted bound to *their*
 *   session, handing them the library files the sync meant for someone else's
 *   player;
 * - their folder then answers *as* the device, including with the Rockbox
 *   index whose ratings `ingestDeviceRatings()` merges into the shared
 *   library.
 *
 * `devices.web_owner_subject` is stamped by `device:add` from the calling
 * session — never from anything the client sends — and the attach is refused
 * rather than granted. Refused, not "evict and hand over": taking the device
 * away from its holder is precisely what must not happen.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest, type Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
  OWNER_PASSWORD,
  OWNER_USERNAME,
  WEB_ORIGIN,
  invoke,
  signIn,
} from "./web-harness";

test.describe.configure({ mode: "serial" });

const INTRUDER_USERNAME = "e2e-device-intruder";
const INTRUDER_PASSWORD = "an-entirely-valid-intruder-password";

let deviceId: number;

interface Identity {
  id: number;
  subject: string;
  isOwner: boolean;
}

async function identityIdFor(
  owner: APIRequestContext,
  subject: string
): Promise<number | undefined> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  return res.identities?.find((i) => i.subject === subject)?.id;
}

test.beforeAll(async ({ request }) => {
  await signIn(request);

  const device = await invoke<{ id: number; transport: string }>(
    request,
    "device:add",
    { name: `Owned Player ${Date.now()}`, transport: "web", modelId: null }
  );
  expect(device.transport).toBe("web");
  deviceId = device.id;

  // A second, perfectly valid, allowlisted account. The whole point is that
  // this is not an outsider: `/api/invoke` lets it through, and it is a full
  // user of the library by design.
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: INTRUDER_USERNAME,
    displayName: "E2E Device Intruder",
    password: INTRUDER_PASSWORD,
  });
});

test.afterAll(async ({ request }) => {
  await signIn(request);
  try {
    if (deviceId) await invoke(request, "device:remove", deviceId);
  } catch {
    /* the scratch daemon is thrown away anyway */
  }
  try {
    const id = await identityIdFor(request, INTRUDER_USERNAME);
    if (id) await invoke(request, "server:revokeIdentity", id);
  } catch {
    /* ditto */
  }
});

/** Signs this page's own cookie jar in as the named local account. */
async function signInPageAs(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  const res = await page.request.post("/api/auth/local/login", {
    data: { username, password },
  });
  expect(res.ok(), `${username} should be able to sign in`).toBe(true);
}

/**
 * Attaches a fresh OPFS directory as the device and returns the client-side
 * state the server's answer produced.
 *
 * The picker is a user-gesture-gated dialog Playwright cannot drive;
 * `navigator.storage.getDirectory()` hands back a real
 * `FileSystemDirectoryHandle` with the identical interface, so the whole File
 * System Access path runs.
 */
async function tryAttach(
  page: Page,
  id: number
): Promise<{ status: string; message?: string }> {
  await page.goto("/");
  // Wait for the bootstrap, not just for markup: the login screen is markup
  // too, and it has no device client.
  await page.waitForFunction(
    () => (window as unknown as { __ipodrocksDevice?: unknown }).__ipodrocksDevice
  );

  await page.evaluate(async (targetId: number) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (
      root as unknown as { keys(): AsyncIterable<string> }
    ).keys()) {
      await root.removeEntry(name, { recursive: true });
    }
    const deviceRoot = await root.getDirectoryHandle(`device-${targetId}`, {
      create: true,
    });
    for (const folder of ["Music", "Podcasts", "Audiobooks", "Playlists"]) {
      await deviceRoot.getDirectoryHandle(folder, { create: true });
    }
    await (
      window as unknown as {
        __ipodrocksDevice: {
          attachHandle(i: number, h: FileSystemDirectoryHandle): Promise<void>;
        };
      }
    ).__ipodrocksDevice.attachHandle(targetId, deviceRoot);
  }, id);

  // The verdict comes back over the socket, so poll rather than sleep: the
  // refusal arrives as a `device-attach-refused` frame and lands on the
  // client's own state.
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (targetId: number) =>
              (
                window as unknown as {
                  __ipodrocksDevice: {
                    stateOf(i: number): { status: string };
                  };
                }
              ).__ipodrocksDevice.stateOf(targetId),
            id
          )
        ).status,
      { timeout: 10_000 }
    )
    .not.toBe("attaching");

  return page.evaluate(
    (targetId: number) =>
      (
        window as unknown as {
          __ipodrocksDevice: {
            stateOf(i: number): { status: string; message?: string };
          };
        }
      ).__ipodrocksDevice.stateOf(targetId),
    id
  );
}

async function isOnline(request: APIRequestContext, id: number): Promise<boolean> {
  const res = await invoke<{ online: boolean }>(request, "device:ping", id);
  return res.online;
}

test("the account that registered a web device can attach it", async ({
  page,
  request,
}) => {
  await signIn(request);
  await signInPageAs(page, OWNER_USERNAME, OWNER_PASSWORD);

  const state = await tryAttach(page, deviceId);
  expect(state.status, state.message ?? "").toBe("attached");
  await expect.poll(() => isOnline(request, deviceId), { timeout: 10_000 }).toBe(true);
});

test("a different allowlisted account cannot take it over", async ({
  browser,
  request,
}) => {
  await signIn(request);

  // The owner is holding it right now — this is the state a takeover would
  // have to break.
  const ownerContext = await browser.newContext({ baseURL: WEB_ORIGIN });
  const ownerPage = await ownerContext.newPage();
  await signInPageAs(ownerPage, OWNER_USERNAME, OWNER_PASSWORD);
  expect((await tryAttach(ownerPage, deviceId)).status).toBe("attached");
  await expect.poll(() => isOnline(request, deviceId), { timeout: 10_000 }).toBe(true);

  const intruderContext = await browser.newContext({ baseURL: WEB_ORIGIN });
  const intruderPage = await intruderContext.newPage();
  await signInPageAs(intruderPage, INTRUDER_USERNAME, INTRUDER_PASSWORD);

  // The control: this account really is signed in and really can use the app,
  // so the refusal below is the ownership check and not a broken login.
  const stranger = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  await stranger.post("/api/auth/local/login", {
    data: { username: INTRUDER_USERNAME, password: INTRUDER_PASSWORD },
  });
  expect((await invoke<{ error?: string }>(stranger, "library:getStats")).error)
    .toBeUndefined();

  const state = await tryAttach(intruderPage, deviceId);
  expect(state.status).toBe("error");
  expect(state.message ?? "").toMatch(/different account/i);

  // And — the part that matters more than the refusal — the owner still has
  // it. An "evict, then refuse" would pass the assertion above and still have
  // taken the player away from the person using it.
  expect(await isOnline(request, deviceId)).toBe(true);

  await stranger.dispose();
  await intruderContext.close();
  await ownerContext.close();
});

test("a client cannot claim ownership of a device it registers", async ({
  browser,
  request,
}) => {
  // `webOwnerSubject` is stamped from the transport that carried the call. A
  // client naming someone else in the body must not be believed, or the
  // column protects nothing — registering a device "for" another identity
  // would be a way to hand them a player, and naming *yourself* on somebody
  // else's registration would be the takeover by a shorter route.
  await signIn(request);
  const device = await invoke<{ id: number }>(request, "device:add", {
    name: `Forged Owner ${Date.now()}`,
    transport: "web",
    modelId: null,
    webOwnerSubject: `local:${INTRUDER_USERNAME}`,
  });
  const context = await browser.newContext({ baseURL: WEB_ORIGIN });
  const page = await context.newPage();
  try {
    await signInPageAs(page, INTRUDER_USERNAME, INTRUDER_PASSWORD);
    // The owner called `device:add`, so the owner holds it — whatever the
    // body said.
    const state = await tryAttach(page, device.id);
    expect(state.status).toBe("error");
    expect(state.message ?? "").toMatch(/different account/i);
  } finally {
    await context.close();
    await invoke(request, "device:remove", device.id);
  }
});
