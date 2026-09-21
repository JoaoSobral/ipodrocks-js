/**
 * Regression — which client may drive which player, in both directions.
 *
 * `tests/e2e/web-device-locality.test.ts` drives the browser half against a
 * real daemon. It cannot drive the other half: every call it makes arrives over
 * HTTP and therefore carries a session id, so "the desktop window must not sync
 * a browser-held player" has no way to be expressed there at all.
 *
 * That direction matters at least as much. A remote device is reachable only
 * through the tab holding its directory handle; the desktop app pointed at one
 * would previously run until `DetachedDeviceFs` threw, with an error that named
 * the filesystem rather than the reason, part-way through a sync.
 *
 * `ctx.sessionId` is the whole discriminator — the web transport sets it,
 * Electron IPC does not — so these tests are about exactly that: `undefined`
 * means the desktop window, and a present id means a browser.
 */
import { describe, expect, it } from "vitest";
import type { HandlerContext } from "../../main/host/bridge";
import { blockWrongAdmin, blockWrongLocality } from "../../main/ipc/common";
import {
  autoPodcastBlock,
  deviceAdminBlock,
  deviceLocalityBlock,
  isRemoteDevice,
} from "../../shared/device-locality";

/** A handler context as each transport builds it. */
const electronCtx = { sender: { send() {}, isDestroyed: () => false } } as HandlerContext;
const webCtx = {
  sender: { send() {}, isDestroyed: () => false },
  sessionId: "a-session",
} as HandlerContext;

describe("deviceLocalityBlock", () => {
  it("refuses a remote device to the desktop app", () => {
    const reason = deviceLocalityBlock("web", false);
    expect(reason).toMatch(/remote device/i);
    // It has to say what to do about it, or the user's next move is to delete
    // a device that is working perfectly well somewhere else.
    expect(reason).toMatch(/browser/i);
  });

  it("refuses a server-side player to a browser", () => {
    expect(deviceLocalityBlock("local", true)).toMatch(/plugged into the server/i);
  });

  it("allows each client its own kind", () => {
    expect(deviceLocalityBlock("local", false)).toBeNull();
    expect(deviceLocalityBlock("web", true)).toBeNull();
  });

  it("reads a missing transport as local", () => {
    // Every device row written before the `transport` column existed, and every
    // one the migration backfilled. Treating those as remote would lock the
    // desktop app out of its own devices on upgrade.
    expect(deviceLocalityBlock(undefined, false)).toBeNull();
    expect(deviceLocalityBlock(undefined, true)).toMatch(/plugged into the server/i);
    expect(isRemoteDevice(undefined)).toBe(false);
  });
});

describe("blockWrongLocality", () => {
  it("derives the client from the transport that carried the call", () => {
    // Not from anything the caller says. A client-supplied "I am the desktop"
    // would be worth exactly as much as the claim itself.
    expect(blockWrongLocality(electronCtx, "web")?.error).toMatch(/remote device/i);
    expect(blockWrongLocality(electronCtx, "local")).toBeNull();
    expect(blockWrongLocality(webCtx, "local")?.error).toMatch(/plugged into the server/i);
    expect(blockWrongLocality(webCtx, "web")).toBeNull();
  });

  it("returns the shape a handler returns", () => {
    // `safe()` handlers report failure as data, never a throw, so the guard has
    // to hand back something a handler can `return` unchanged.
    const blocked = blockWrongLocality(electronCtx, "web");
    expect(blocked).not.toBeNull();
    expect(Object.keys(blocked!)).toEqual(["error"]);
  });
});

describe("autoPodcastBlock", () => {
  it("refuses a remote device and explains the schedule, not the transport", () => {
    const reason = autoPodcastBlock("web");
    expect(reason).toMatch(/browser tab/i);
  });

  it("leaves a local player alone", () => {
    expect(autoPodcastBlock("local")).toBeNull();
    expect(autoPodcastBlock(undefined)).toBeNull();
  });
});

describe("deviceAdminBlock", () => {
  it("is asymmetric on purpose, unlike the locality rule", () => {
    // The desktop app may remove a remote device: it holds the database, and
    // somebody has to be able to tidy up a browser that is never coming back.
    expect(deviceAdminBlock("web", false)).toBeNull();
    // A browser may not touch a server-attached device's settings at all. Its
    // mount path, USB identity and folder layout are facts about a machine the
    // browser cannot see and could never verify.
    expect(deviceAdminBlock("local", true)).toMatch(/machine running the server/i);
  });

  it("leaves each client its own kind alone", () => {
    expect(deviceAdminBlock("local", false)).toBeNull();
    expect(deviceAdminBlock("web", true)).toBeNull();
  });

  it("is narrower than deviceLocalityBlock, which is the point", () => {
    // Same client, same device, different verb: the desktop app cannot *sync*
    // a remote device but can still delete it. Collapsing the two would either
    // strand rows forever or hand a browser the server's device config.
    expect(deviceLocalityBlock("web", false)).not.toBeNull();
    expect(deviceAdminBlock("web", false)).toBeNull();
  });

  it("is enforced from the transport that carried the call", () => {
    expect(blockWrongAdmin(webCtx, "local")?.error).toMatch(/machine running the server/i);
    expect(blockWrongAdmin(webCtx, "web")).toBeNull();
    expect(blockWrongAdmin(electronCtx, "web")).toBeNull();
    expect(blockWrongAdmin(electronCtx, "local")).toBeNull();
  });
});
