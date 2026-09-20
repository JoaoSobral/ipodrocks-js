/**
 * Regression — OAuth proves identity; the allowlist grants admission.
 *
 * This is the single most dangerous thing about turning web mode on. Anyone on
 * earth can complete a Google login against this server's client id and arrive
 * at the callback with a valid, verified profile. If a successful provider
 * login were treated as authorization, configuring Google would be
 * indistinguishable from publishing the library.
 *
 * The e2e suite drives the local-password half of this, but it cannot drive a
 * real provider. `authorizeIdentity()` is the one function both paths call, so
 * it is tested here directly — and every property below is the whole of what
 * the OAuth callback relies on.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let mod: typeof import("../../server/auth/identities");
let db: typeof import("../../server/db");

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-allowlist-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  setHost(createNodeHost());
  db = await import("../../server/db");
  // `server/db.ts` caches its connection, so the previous test's file would
  // otherwise still be the one this test writes to.
  db.closeServerDb();
  mod = await import("../../server/auth/identities");
});

afterEach(() => {
  db.closeServerDb();
  resetHost();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("authorizeIdentity", () => {
  it("refuses an unknown identity once the server has an owner", () => {
    const token = mod.getOrCreateClaimToken();
    expect(token).not.toBeNull();

    const owner = mod.authorizeIdentity({
      provider: "google",
      subject: "owner-subject",
      email: "owner@example.com",
      claimToken: token,
    });
    expect("identity" in owner).toBe(true);

    // A *successful* Google login by someone else. The profile is perfectly
    // valid; that is the point.
    const stranger = mod.authorizeIdentity({
      provider: "google",
      subject: "stranger-subject",
      email: "stranger@example.com",
    });
    expect("error" in stranger).toBe(true);
  });

  it("refuses the very first identity when the claim token is wrong or absent", () => {
    mod.getOrCreateClaimToken();

    expect(
      "error" in
        mod.authorizeIdentity({ provider: "github", subject: "first" })
    ).toBe(true);
    expect(
      "error" in
        mod.authorizeIdentity({
          provider: "github",
          subject: "first",
          claimToken: "guessed",
        })
    ).toBe(true);
    // And nothing was created along the way.
    expect(mod.countIdentities()).toBe(0);
  });

  it("consumes the claim token, so it cannot be replayed to add a second account", () => {
    const token = mod.getOrCreateClaimToken();
    mod.authorizeIdentity({ provider: "google", subject: "owner", claimToken: token });

    expect(mod.getOrCreateClaimToken()).toBeNull();
    const replay = mod.authorizeIdentity({
      provider: "google",
      subject: "second",
      claimToken: token,
    });
    expect("error" in replay).toBe(true);
    expect(mod.countIdentities()).toBe(1);
  });

  it("matches on the provider subject, never on the email address", () => {
    const token = mod.getOrCreateClaimToken();
    mod.authorizeIdentity({
      provider: "google",
      subject: "stable-id-123",
      email: "owner@example.com",
      claimToken: token,
    });

    // Someone else who has since acquired the owner's old address. A match on
    // email would hand them the account; a match on subject does not.
    const impostor = mod.authorizeIdentity({
      provider: "google",
      subject: "different-id-456",
      email: "owner@example.com",
    });
    expect("error" in impostor).toBe(true);

    // The real owner, whose address changed, still gets in.
    const returning = mod.authorizeIdentity({
      provider: "google",
      subject: "stable-id-123",
      email: "new-address@example.com",
    });
    expect("identity" in returning).toBe(true);
  });

  it("never re-derives owner status from the provider on a later login", () => {
    const token = mod.getOrCreateClaimToken();
    const owner = mod.authorizeIdentity({
      provider: "local",
      subject: "owner",
      claimToken: token,
    });
    expect("identity" in owner && owner.identity.isOwner).toBe(true);

    const added = mod.addIdentity({ provider: "github", subject: "guest" });
    expect(added.isOwner).toBe(false);

    // A repeat login refreshes the profile but must not promote.
    const again = mod.authorizeIdentity({
      provider: "github",
      subject: "guest",
      displayName: "Guest",
    });
    expect("identity" in again && again.identity.isOwner).toBe(false);
  });

  it("refuses to remove the owner, which would leave the allowlist uneditable", () => {
    const token = mod.getOrCreateClaimToken();
    const owner = mod.authorizeIdentity({
      provider: "local",
      subject: "owner",
      claimToken: token,
    });
    if (!("identity" in owner)) throw new Error("claim failed");

    expect("error" in mod.removeIdentity(owner.identity.id)).toBe(true);

    const guest = mod.addIdentity({ provider: "github", subject: "guest" });
    expect("ok" in mod.removeIdentity(guest.id)).toBe(true);
  });
});

describe("local passwords", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    await mod.createLocalAccount("someone", "a-long-enough-password");
    expect(
      await mod.verifyLocalLogin("someone", "a-long-enough-password")
    ).not.toBeNull();
    expect(await mod.verifyLocalLogin("someone", "wrong")).toBeNull();
  });

  it("returns null for an unknown user without revealing that it is unknown", async () => {
    // The real defence is that both paths run a scrypt derivation, so the
    // timing does not distinguish them. What is assertable here is that the
    // unknown-user path does not short-circuit to a different answer shape.
    expect(await mod.verifyLocalLogin("nobody", "whatever")).toBeNull();
  });

  it("folds the username case, so an account cannot be shadowed by its own capitalisation", async () => {
    await mod.createLocalAccount("Owner", "a-long-enough-password");
    expect(
      await mod.verifyLocalLogin("OWNER", "a-long-enough-password")
    ).not.toBeNull();
  });
});
