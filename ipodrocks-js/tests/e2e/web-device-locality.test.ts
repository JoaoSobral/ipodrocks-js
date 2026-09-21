/**
 * Playwright E2E — a player is plugged into one machine, and the other one
 * refuses to pretend otherwise.
 *
 * Web mode splits the app across two computers: the library, the database and
 * the encoders on the server, the *player* in whatever browser you open it
 * from. Which means a device's `transport` is not a preference but a fact about
 * which machine the thing is physically attached to, and each client can drive
 * exactly one kind:
 *
 *   - a **remote** player (`web`) exists only while a browser tab holds its
 *     directory handle, so the desktop app cannot touch it;
 *   - a **local** player (`local`) is on the server's own USB bus, so a browser
 *     cannot touch it either.
 *
 * Before this was enforced, both mistakes were silent-ish and expensive. A web
 * client syncing a server-attached device ran a whole sync against the wrong
 * filesystem; the desktop window syncing a browser-held one died inside
 * `DetachedDeviceFs` with an error naming neither the device nor the reason.
 *
 * The guard is in the handlers, not the UI, and `ctx.sessionId` is the whole
 * test: the web transport sets it and Electron IPC does not, so "which client
 * is this" comes from the transport that carried the call rather than from
 * anything the client can claim. That is what this spec drives — over HTTP,
 * which means every call here arrives with a session id, i.e. as a browser.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { invoke, removeDeviceRow, seedLocalDeviceRow, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

interface Device {
  id: number;
  name: string;
  transport?: "local" | "web";
}

async function addDevice(
  request: APIRequestContext,
  payload: Record<string, unknown>
): Promise<Device> {
  const device = await invoke<Device & { error?: string }>(
    request,
    "device:add",
    payload
  );
  expect(device.error).toBeUndefined();
  return device;
}

/** Local devices cannot be removed by a web client — by design — so cleanup
 *  goes straight at the row. A remote one goes through the app as usual. */
async function removeDevice(
  request: APIRequestContext,
  id: number,
  transport: "local" | "web"
): Promise<void> {
  if (transport === "web") await invoke(request, "device:remove", id);
  else removeDeviceRow(id);
}

async function readDevice(
  request: APIRequestContext,
  id: number
): Promise<(Device & { autoPodcastsEnabled?: boolean }) | undefined> {
  const list = await invoke<(Device & { autoPodcastsEnabled?: boolean })[]>(
    request,
    "device:list"
  );
  return list.find((d) => d.id === id);
}

test("a browser cannot sync a player attached to the server", async ({ request }) => {
  await signIn(request);

  // A perfectly ordinary server-side device: this is what the desktop app adds,
  // and what a daemon with a player on its own USB bus would have.
  // Seeded past the app: `device:add` from a browser now always yields a
  // remote device, so a server-side one has to be planted the way the desktop
  // app would have created it.
  const device = {
    id: seedLocalDeviceRow(`Locality local ${Date.now()}`, "/tmp/ipr-locality-local"),
  };

  try {
    const sync = await invoke<{ error?: string }>(request, "sync:start", {
      deviceId: device.id,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
    });
    expect(sync.error, "a web client must be refused a server-side player").toMatch(
      /plugged into the server/i
    );

    // `device:check` is the other door onto the same filesystem and is refused
    // the same way — a refusal on sync alone would still let a browser walk the
    // server's device tree.
    const check = await invoke<{ error?: string }>(request, "device:check", device.id);
    expect(check.error).toMatch(/plugged into the server/i);
  } finally {
    await removeDevice(request, device.id, "local");
  }
});

test("a browser can operate a remote device, and the refusal is not blanket", async ({
  request,
}) => {
  await signIn(request);

  const device = await addDevice(request, {
    name: `Locality remote ${Date.now()}`,
    transport: "web",
  });

  try {
    // Nothing is holding it, so this must fail — but on *connection*, not on
    // locality. The distinction is the point: the guard above must not be so
    // broad that it swallows the case web mode exists for.
    const sync = await invoke<{ error?: string }>(request, "sync:start", {
      deviceId: device.id,
      syncType: "full",
      extraTrackPolicy: "keep",
      includeMusic: true,
    });
    expect(sync.error ?? "").not.toMatch(/plugged into the server/i);
    expect(sync.error ?? "").not.toMatch(/remote device/i);
  } finally {
    await removeDevice(request, device.id, "web");
  }
});

test("Auto Podcasts is refused on a remote device", async ({ request }) => {
  await signIn(request);

  const device = await addDevice(request, {
    name: `Locality podcasts ${Date.now()}`,
    transport: "web",
  });

  try {
    // The scheduler is a timer in the server process. A remote device is
    // connected only while its tab is open, so a schedule aimed at one either
    // does nothing or pushes gigabytes through a browser nobody is watching.
    const on = await invoke<{ error?: string }>(
      request,
      "podcast:setDeviceAutoPodcasts",
      device.id,
      true
    );
    expect(on.error).toMatch(/remote device/i);

    expect((await readDevice(request, device.id))?.autoPodcastsEnabled ?? false).toBe(
      false
    );

    // Turning it *off* is never refused: a device that should not have had the
    // flag must always be able to give it up.
    const off = await invoke<{ error?: string }>(
      request,
      "podcast:setDeviceAutoPodcasts",
      device.id,
      false
    );
    expect(off?.error).toBeUndefined();
  } finally {
    await removeDevice(request, device.id, "web");
  }
});

test("a local player still takes Auto Podcasts", async ({ request }) => {
  await signIn(request);

  // The control for the test above: the refusal is about the transport, not
  // about the channel having been broken.
  const device = {
    id: seedLocalDeviceRow(
      `Locality podcasts local ${Date.now()}`,
      "/tmp/ipr-locality-local-pod"
    ),
  };

  try {
    const on = await invoke<{ error?: string }>(
      request,
      "podcast:setDeviceAutoPodcasts",
      device.id,
      true
    );
    expect(on?.error).toBeUndefined();

    expect((await readDevice(request, device.id))?.autoPodcastsEnabled).toBe(true);
  } finally {
    await removeDevice(request, device.id, "local");
  }
});
