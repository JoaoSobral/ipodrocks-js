/**
 * Regression — the remote-library peer client as an SSRF target.
 *
 * The recipient connects, on a timer, to a host that arrived in an invite
 * link. Every rule below is one way that link (or the host behind it, later)
 * could aim this server somewhere it should not go:
 *
 * - DNS rebinding: each request re-resolves and judges *every* address, then
 *   connects to the one it judged;
 * - redirects of every flavour — to a private address, to another hostname,
 *   to the same host on another port — are refused, never followed;
 * - every textual form of loopback and of the metadata address is refused,
 *   including decimal/octal/hex IPv4 and IPv4-mapped IPv6;
 * - the metadata endpoints that sit *inside* ranges a LAN peer may use
 *   (`fd00:ec2::254`, `100.100.100.200`) are refused with the LAN flag on;
 * - non-http(s) schemes, and plain http without the LAN flag, never pair;
 * - the global `IPODROCKS_ALLOW_PRIVATE_FETCH` does not widen a peer's policy;
 * - a host that answers at the pinned origin but cannot countersign — a
 *   re-pointed hostname — is refused even though the connection succeeded;
 * - Cloudflare Access credentials are never sent to anything but the pinned
 *   origin.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setHost, createNodeHost, resetHost } from "../../main/host";

let dataDir: string;
let safeFetchMod: typeof import("../../main/utils/safe-fetch");
let policy: typeof import("../../main/remote-library/peer-policy");
let client: typeof import("../../main/remote-library/peer-client");
let signing: typeof import("../../server/federation/signing");
let db: typeof import("../../server/db");

const servers: http.Server[] = [];

async function listen(app: express.Express): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { port: (server.address() as { port: number }).port, hits: () => hits };
}

function sharerKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), privateKey };
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-peer-ssrf-"));
  process.env.IPODROCKS_DATA_DIR = dataDir;
  delete process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK;
  setHost(createNodeHost());
  db = await import("../../server/db");
  db.closeServerDb();
  safeFetchMod = await import("../../main/utils/safe-fetch");
  policy = await import("../../main/remote-library/peer-policy");
  client = await import("../../main/remote-library/peer-client");
  signing = await import("../../server/federation/signing");
  signing.resetServerKeyPair();
});

afterEach(async () => {
  delete process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK;
  safeFetchMod.setHostResolverForTests(null);
  safeFetchMod.setPrivateFetchAllowed(false);
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  db.closeServerDb();
  resetHost();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("address policy", () => {
  const refused = (ip: string, lan: boolean) => policy.peerAddressRefused(ip, lan);

  it("admits public addresses and refuses private ones without the LAN flag", () => {
    expect(refused("8.8.8.8", false)).toBe(false);
    expect(refused("2606:4700:4700::1111", false)).toBe(false);
    for (const ip of ["192.168.1.5", "10.0.0.2", "172.16.4.4", "100.64.1.2", "fd12::1"]) {
      expect(refused(ip, false)).toBe(true);
    }
  });

  it("admits LAN, CGNAT/tailnet and unique-local ranges with the flag", () => {
    for (const ip of ["192.168.1.5", "10.0.0.2", "172.31.255.1", "100.101.102.103", "fd12::1", "::ffff:192.168.1.5"]) {
      expect(refused(ip, true)).toBe(false);
    }
  });

  it("refuses loopback, link-local and multicast in every spelling, flag or not", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0.0.0.0",
      "::",
      "169.254.1.1",
      "fe80::1",
      "fe80::1%en0",
      "224.0.0.1",
      "ff02::1",
      "255.255.255.255",
    ]) {
      expect(refused(ip, true), ip).toBe(true);
      expect(refused(ip, false), ip).toBe(true);
    }
  });

  it("refuses the metadata endpoints even where their range is allowed", () => {
    for (const ip of [
      "169.254.169.254",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "fd00:ec2::254",
      "fd00:0ec2:0000:0000:0000:0000:0000:0254",
      "100.100.100.200",
      "100.100.100.100",
      "::ffff:100.100.100.200",
    ]) {
      expect(refused(ip, true), ip).toBe(true);
    }
  });

  it("allows loopback only behind both the test switch and the LAN flag", () => {
    process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK = "1";
    expect(refused("127.0.0.1", true)).toBe(false);
    expect(refused("127.0.0.1", false)).toBe(true);
    // Never the metadata address, whatever is switched on.
    expect(refused("169.254.169.254", true)).toBe(true);
  });

  it("refuses decimal, octal and hex IPv4 hosts once the URL parser normalizes them", async () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://0x7f000001/",
      "http://2852039166/", // 169.254.169.254
      "http://[::ffff:169.254.169.254]/",
    ]) {
      await expect(
        safeFetchMod.safeFetch(url, { addressPolicy: policy.peerAddressPolicy(true), redirect: "error" }),
        url
      ).rejects.toBeInstanceOf(safeFetchMod.BlockedUrlError);
    }
  });

  it("is not widened by the global private-fetch switch", async () => {
    const { port, hits } = await listen(express().get("/", (_req, res) => res.send("hi")));
    safeFetchMod.setPrivateFetchAllowed(true);
    await expect(
      safeFetchMod.safeFetch(`http://127.0.0.1:${port}/`, {
        addressPolicy: policy.peerAddressPolicy(true),
        redirect: "error",
      })
    ).rejects.toBeInstanceOf(safeFetchMod.BlockedUrlError);
    expect(hits()).toBe(0);
    // Control: the switch does open an ordinary feed fetch.
    expect((await safeFetchMod.safeFetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  });
});

describe("DNS", () => {
  it("judges every resolved address, and refuses a rebinding answer on the next request", async () => {
    process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK = "1";
    const { port, hits } = await listen(express().get("/", (_req, res) => res.send("ok")));
    let call = 0;
    safeFetchMod.setHostResolverForTests(async () => {
      call++;
      return call === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    });
    const init = { addressPolicy: policy.peerAddressPolicy(true), redirect: "error" as const };
    expect((await safeFetchMod.safeFetch(`http://peer.test:${port}/`, init)).status).toBe(200);
    await expect(safeFetchMod.safeFetch(`http://peer.test:${port}/`, init)).rejects.toBeInstanceOf(
      safeFetchMod.BlockedUrlError
    );
    expect(hits()).toBe(1);
  });

  it("refuses a name that resolves to a mix of allowed and refused addresses", async () => {
    safeFetchMod.setHostResolverForTests(async () => [
      { address: "192.168.1.10", family: 4 },
      { address: "100.100.100.200", family: 4 },
    ]);
    await expect(
      safeFetchMod.safeFetch("http://peer.test/", { addressPolicy: policy.peerAddressPolicy(true), redirect: "error" })
    ).rejects.toBeInstanceOf(safeFetchMod.BlockedUrlError);
  });
});

describe("redirects", () => {
  it("refuses every redirect without following it", async () => {
    process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK = "1";
    const target = await listen(express().use((_req, res) => { res.send("reached"); }));
    const locations = [
      "http://169.254.169.254/latest/meta-data/",
      "http://another-host.test/",
      `http://127.0.0.1:${target.port}/`, // same host, other port
      "/elsewhere", // same origin
    ];
    for (const location of locations) {
      const redirector = await listen(express().use((_req, res) => res.redirect(302, location)));
      await expect(
        safeFetchMod.safeFetch(`http://127.0.0.1:${redirector.port}/`, {
          addressPolicy: policy.peerAddressPolicy(true),
          redirect: "error",
        }),
        location
      ).rejects.toThrow(/redirect/i);
    }
    expect(target.hits()).toBe(0);
  });

  it("refuses a request body without redirect: error, so it can never be re-sent", async () => {
    await expect(safeFetchMod.safeFetch("https://example.test/", { method: "POST", body: "x" })).rejects.toThrow(
      /redirect/
    );
  });
});

describe("invites", () => {
  const code = "A".repeat(32);
  const id = "B".repeat(16);

  it("pins a canonical origin and refuses anything else in the link", () => {
    const ok = client.parseInvite(`https://Peer.Example.COM:443/#share=${id}.${code}`, false);
    expect(ok).toEqual({ origin: "https://peer.example.com", shareId: id, code });
    for (const bad of [
      `file:///etc/passwd#share=${id}.${code}`,
      `ftp://peer.example/#share=${id}.${code}`,
      `gopher://peer.example/#share=${id}.${code}`,
      `javascript:alert(1)//#share=${id}.${code}`,
      `https://user:pw@peer.example/#share=${id}.${code}`,
      `https://peer.example/some/path#share=${id}.${code}`,
      `https://peer.example/?x=1#share=${id}.${code}`,
      `https://peer.example/#share=${id}.short`,
    ]) {
      expect("error" in client.parseInvite(bad, true), bad).toBe(true);
    }
  });

  it("refuses plain http unless the peer is flagged LAN", () => {
    expect("error" in client.parseInvite(`http://peer.example/#share=${id}.${code}`, false)).toBe(true);
    expect("error" in client.parseInvite(`http://peer.example/#share=${id}.${code}`, true)).toBe(false);
  });
});

describe("the pinned peer must prove itself", () => {
  async function fakePeer(signWith: crypto.KeyObject | null, seen?: (h: http.IncomingHttpHeaders) => void) {
    process.env.IPODROCKS_FEDERATION_ALLOW_LOOPBACK = "1";
    const app = express();
    app.get("/api/federation/info", (req, res) => {
      seen?.(req.headers);
      const nonce = String(req.headers[signing.HDR_NONCE] ?? "");
      const shareId = String(req.headers[signing.HDR_SHARE] ?? "");
      if (signWith) {
        res.setHeader(
          signing.HDR_RESPONSE_SIGNATURE,
          crypto
            .sign(null, Buffer.from(["ipodrocks-federation-response-v1", shareId, nonce].join("\n")), signWith)
            .toString("base64url")
        );
      }
      res.json({ trackCount: 0 });
    });
    return listen(app);
  }

  it("refuses an answer with no countersignature, or one from another key", async () => {
    const pinned = sharerKeyPair();
    const impostor = sharerKeyPair();
    for (const signer of [null, impostor.privateKey]) {
      const { port } = await fakePeer(signer);
      const c = new client.PeerClient({
        origin: `http://127.0.0.1:${port}`,
        shareId: "S".repeat(16),
        sharerPublicKey: pinned.publicKey,
        lan: true,
      });
      await expect(c.getJson("/api/federation/info")).rejects.toMatchObject({ kind: "unverified" });
    }
    // Control: the pinned key's own countersignature is accepted.
    const { port } = await fakePeer(pinned.privateKey);
    const c = new client.PeerClient({
      origin: `http://127.0.0.1:${port}`,
      shareId: "S".repeat(16),
      sharerPublicKey: pinned.publicKey,
      lan: true,
    });
    await expect(c.getJson("/api/federation/info")).resolves.toEqual({ trackCount: 0 });
  });

  it("sends Cloudflare Access credentials to the pinned origin and nowhere else", async () => {
    const pinned = sharerKeyPair();
    const received: http.IncomingHttpHeaders[] = [];
    const { port } = await fakePeer(pinned.privateKey, (h) => received.push(h));
    const c = new client.PeerClient({
      origin: `http://127.0.0.1:${port}`,
      shareId: "S".repeat(16),
      sharerPublicKey: pinned.publicKey,
      lan: true,
      cf: { clientId: "client-id.access", clientSecret: "client-secret-value" },
    });
    await c.getJson("/api/federation/info");
    expect(received[0]["cf-access-client-id"]).toBe("client-id.access");

    // Any path that would leave the pinned origin is refused before a request.
    await expect(c.request("//evil.test/api/federation/info")).rejects.toMatchObject({ kind: "invalid" });
    await expect(c.request("/somewhere-else")).rejects.toMatchObject({ kind: "invalid" });
    expect(received).toHaveLength(1);
  });
});
