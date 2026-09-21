/**
 * @vitest-environment node
 *
 * Regressions from the 2026-09 security audit.
 *
 * Each block pins one boundary that was demonstrated to be crossable. They are
 * grouped in one file because they share nothing but their origin; the comment
 * above each `describe` is the finding it belongs to.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import * as path from "path";

import { assertLibrivoxId, getChapterDir } from "@main/audiobooks/audiobook-storage";
import {
  assertPublicHttpUrl,
  isBlockedAddress,
  safeFetch,
  setPrivateFetchAllowed,
} from "@main/utils/safe-fetch";
import { blockWebClientDialog } from "@main/ipc/common";
import { deviceLocalityBlock } from "@shared/device-locality";

// ---------------------------------------------------------------------------
// `librivox_id` is a path component and arrives over IPC.
//
// `librivox_id INTEGER NOT NULL` does not coerce it: SQLite's INTEGER affinity
// leaves a non-integer literal stored as TEXT, so `"../.."` came back out as a
// string, `path.join` resolved it out of the audiobooks root, and
// `audiobook:unsubscribe` `rmSync`'d that directory recursively.
// ---------------------------------------------------------------------------
describe("audiobook librivoxId cannot escape the audiobooks root", () => {
  it("refuses a traversal string", () => {
    expect(() => assertLibrivoxId("../../../../tmp/EVIL")).toThrow(/invalid LibriVox id/);
    expect(() => getChapterDir("../../../../tmp/EVIL" as unknown as number)).toThrow();
  });

  it("refuses the other shapes that are not a positive integer", () => {
    for (const bad of ["", ".", "..", "1/../../x", "1e9999", "NaN", -1, 0, 1.5, null, undefined]) {
      expect(() => assertLibrivoxId(bad as unknown)).toThrow();
    }
  });

  it("accepts a real id and keeps it inside the root", () => {
    expect(assertLibrivoxId(12345)).toBe(12345);
    expect(assertLibrivoxId("12345")).toBe(12345);
    const dir = getChapterDir(12345);
    expect(path.basename(dir)).toBe("12345");
    expect(dir.endsWith(path.join("auto-audiobooks", "12345"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A URL a client chose must not reach the daemon's own network position, and
// the redirect hop is the half that is easy to forget.
// ---------------------------------------------------------------------------
describe("safeFetch refuses non-public targets", () => {
  afterEach(() => setPrivateFetchAllowed(false));

  it("classifies the address ranges that matter", () => {
    for (const ip of [
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1",
      "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses a non-http scheme", async () => {
    await expect(assertPublicHttpUrl("file:///etc/hosts")).rejects.toThrow(/Only http/);
    await expect(assertPublicHttpUrl("data:text/xml,<rss/>")).rejects.toThrow(/Only http/);
  });

  it("refuses a literal loopback and RFC1918 host", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1:8780/feed")).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpUrl("http://[::1]/feed")).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /non-public/
    );
  });

  it("refuses a redirect that lands on a private address", async () => {
    // The internal service the redirect points at. Nothing must reach it.
    let internalHits = 0;
    const internal = http.createServer((_req, res) => {
      internalHits++;
      res.writeHead(200).end("INTERNAL-BODY");
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    const internalPort = (internal.address() as { port: number }).port;

    // A redirector that is itself reachable only because the guard is off for
    // the first hop; the point is that the *second* hop is re-checked.
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/` }).end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const redirPort = (redirector.address() as { port: number }).port;

    try {
      setPrivateFetchAllowed(true);
      const allowed = await safeFetch(`http://127.0.0.1:${redirPort}/`);
      expect(await allowed.text()).toBe("INTERNAL-BODY"); // control: it does redirect
      expect(internalHits).toBe(1);

      setPrivateFetchAllowed(false);
      await expect(safeFetch(`http://127.0.0.1:${redirPort}/`)).rejects.toThrow(/non-public/);
      expect(internalHits).toBe(1); // the guarded run never reached it
    } finally {
      await new Promise<void>((r) => internal.close(() => r()));
      await new Promise<void>((r) => redirector.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// A native dialog belongs to whoever is sitting at the host. `dialog:pickFolder`
// and `app:openExternal` always refused a web client; `playlist:export` and
// `podcast:browseDownloadDir` reached the same sink without the check.
// ---------------------------------------------------------------------------
describe("host-native dialogs are refused to a web client", () => {
  it("refuses a session-bearing caller and admits Electron IPC", () => {
    expect(blockWebClientDialog({ sessionId: "sess-abc" } as never)).not.toBeNull();
    expect(blockWebClientDialog({ sessionId: undefined } as never)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Locality answers "is this player on my machine", never "is this player mine".
// Pinned here so the distinction is not quietly re-merged.
// ---------------------------------------------------------------------------
describe("device locality is not an ownership test", () => {
  it("admits every web client for every web device", () => {
    expect(deviceLocalityBlock("web", true)).toBeNull();
    expect(deviceLocalityBlock("local", true)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The assistant's stored conversation was one global table, so on a shared
// server one identity's prompts were readable by every other, and
// `assistant:history:clear` erased everybody's.
// ---------------------------------------------------------------------------
describe("assistant history is partitioned per identity", () => {
  it("keeps each identity's turns, pins and clears to itself", async () => {
    const { createTestDb, closeDb, canRunDbTests } = await import("../harness");
    if (!canRunDbTests) return;
    const {
      saveAssistantMessages,
      loadAssistantHistory,
      loadNonPinnedHistory,
      clearAssistantHistory,
      pinMessages,
      getPinnedCount,
    } = await import("@main/assistant/assistantChat");

    const db = createTestDb();
    try {
      const alice = "google:alice";
      const bob = "google:bob";

      const a = saveAssistantMessages(db, "alice-secret-prompt", "ok", alice);
      saveAssistantMessages(db, "bob-secret-prompt", "ok", bob);
      saveAssistantMessages(db, "desktop-prompt", "ok", null);

      const seen = (s: string | null) =>
        loadAssistantHistory(db, s).map((m) => m.content);

      expect(seen(alice)).toContain("alice-secret-prompt");
      expect(seen(alice)).not.toContain("bob-secret-prompt");
      expect(seen(alice)).not.toContain("desktop-prompt");
      expect(seen(bob)).toEqual(["bob-secret-prompt", "ok"]);
      expect(seen(null)).toEqual(["desktop-prompt", "ok"]);

      // Pins are counted and read per identity.
      pinMessages(db, a.userMsgId, a.assistantMsgId, alice);
      expect(getPinnedCount(db, alice)).toBe(1);
      expect(getPinnedCount(db, bob)).toBe(0);
      expect(loadNonPinnedHistory(db, alice)).toEqual([]);

      // A clear reaches only the caller's own rows.
      clearAssistantHistory(db, bob);
      expect(seen(bob)).toEqual([]);
      expect(seen(alice)).toContain("alice-secret-prompt");
      expect(seen(null)).toContain("desktop-prompt");
    } finally {
      closeDb(db);
    }
  });
});
