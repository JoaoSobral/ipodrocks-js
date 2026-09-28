/**
 * @vitest-environment node
 *
 * Regressions from the 2026-09-28 security findings against `safeFetch`, the
 * one door every client-chosen URL goes out through.
 *
 * 1. IPv4-mapped IPv6 literals in their *hex* spelling walked past the guard.
 *    `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]` —
 *    the WHATWG serializer never emits the dotted form — and the check only
 *    recognised the dotted form. Addresses are now judged on their parsed
 *    128-bit value.
 * 2. DNS rebinding: the guard resolved the name, then `fetch()` resolved it
 *    again for the connect. The connect now reuses the vetted answer.
 * 3. No time bound anyone could rely on: a socket that goes quiet is now let go
 *    whatever the caller passed.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import * as net from "net";
import * as zlib from "zlib";

import {
  assertPublicHttpUrl,
  isBlockedAddress,
  parseIpv6,
  safeFetch,
  setHostResolverForTests,
  setPrivateFetchAllowed,
} from "@main/utils/safe-fetch";

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as net.AddressInfo).port };
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  return new Promise((r) => server.close(() => r()));
}

afterEach(() => {
  setPrivateFetchAllowed(false);
  setHostResolverForTests(null);
});

// ---------------------------------------------------------------------------
// 1. IPv6 is classified by value, not by spelling.
// ---------------------------------------------------------------------------
describe("IPv6 addresses are judged on their parsed value", () => {
  it("parses every spelling of one address to the same groups", () => {
    const want = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1];
    for (const s of ["::ffff:7f00:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "[::FFFF:7F00:0001]"]) {
      expect(parseIpv6(s), s).toEqual(want);
    }
    expect(parseIpv6("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("1::2::3")).toBeNull();
    expect(parseIpv6("12345::")).toBeNull();
  });

  it("blocks v4-embedded forms by the v4 address inside", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1, the hex form the URL parser produces
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:a9fe:a9fe", // 169.254.169.254, cloud metadata
      "::ffff:a00:1", // 10.0.0.1
      "::ffff:ac11:1", // 172.17.0.1, the docker bridge
      "::ffff:c0a8:101", // 192.168.1.1
      "::7f00:1", // IPv4-compatible ::/96
      "::ffff:0:7f00:1", // IPv4-translated
      "64:ff9b::7f00:1", // NAT64 well-known prefix
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::1", // local-use NAT64
      "2002:7f00:1::", // 6to4 of 127.0.0.1
      "2002:c0a8:101::1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("blocks the non-global ranges and admits global unicast", () => {
    for (const ip of ["::", "::1", "fe80::1", "febf::1", "fec0::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "2001::1", "100::1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "2606:2800:220:1:248:1893:25c8:1946",
      "2a00:1450:4001:82a::200e",
      "::ffff:808:808", // 8.8.8.8, mapped — public inside, so public
      "64:ff9b::808:808",
      "2002:808:808::1",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("refuses bracketed v4-mapped literals through assertPublicHttpUrl, dotted or hex", async () => {
    for (const url of [
      "http://[::ffff:7f00:1]:8780/",
      "http://[::ffff:127.0.0.1]:8780/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[::7f00:1]/",
    ]) {
      await expect(assertPublicHttpUrl(url), url).rejects.toThrow(/non-public/);
    }
    // Control: a public mapped literal is still a URL.
    await expect(assertPublicHttpUrl("http://[::ffff:808:808]/")).resolves.toBeInstanceOf(URL);
  });

  it("refuses a redirect whose Location is a hex v4-mapped literal", async () => {
    let internalHits = 0;
    const internal = await listen((_req, res) => {
      internalHits++;
      res.writeHead(200).end("INTERNAL-BODY");
    });
    // The first hop has to be reachable, so the guard is off for it — and the
    // redirector switches it back on before answering, so the hop under test
    // (the Location) is judged by the real guard.
    let rearm = true;
    const redirector = await listen((req, res) => {
      if (rearm) setPrivateFetchAllowed(false);
      const target = req.url === "/control"
        ? `http://127.0.0.1:${internal.port}/`
        : `http://[::ffff:7f00:1]:${internal.port}/`;
      res.writeHead(302, { location: target }).end();
    });
    try {
      // Control: with the guard left off, the redirect is followed.
      rearm = false;
      setPrivateFetchAllowed(true);
      const ok = await safeFetch(`http://127.0.0.1:${redirector.port}/control`);
      expect(await ok.text()).toBe("INTERNAL-BODY");
      expect(internalHits).toBe(1);

      rearm = true;
      setPrivateFetchAllowed(true);
      await expect(safeFetch(`http://127.0.0.1:${redirector.port}/`)).rejects.toThrow(/non-public/);
      expect(internalHits).toBe(1); // the hex literal never reached it
    } finally {
      await close(internal.server);
      await close(redirector.server);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The connect uses the address the check approved — resolved once.
// ---------------------------------------------------------------------------
describe("safeFetch pins each connection to the vetted address", () => {
  it("connects through its own resolution, keeping the name in Host (control)", async () => {
    let seenHost: string | undefined;
    const srv = await listen((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200).end("PINNED");
    });
    let calls = 0;
    setHostResolverForTests(async () => {
      calls++;
      return [{ address: "127.0.0.1", family: 4 }];
    });
    try {
      // `.invalid` never resolves in real DNS (RFC 6761), so reaching the
      // listener at all proves the socket used the resolver's answer.
      setPrivateFetchAllowed(true);
      const res = await safeFetch(`http://pinned.invalid:${srv.port}/`);
      expect(await res.text()).toBe("PINNED");
      expect(seenHost).toBe(`pinned.invalid:${srv.port}`);
      expect(calls).toBe(1);
    } finally {
      await close(srv.server);
    }
  });

  it("a rebinding resolver (public, then loopback) never reaches the loopback listener", async () => {
    let loopbackHits = 0;
    const srv = await listen((_req, res) => {
      loopbackHits++;
      res.writeHead(200).end("INTERNAL-BODY");
    });
    let calls = 0;
    setHostResolverForTests(async () => {
      calls++;
      // First answer passes the guard; every later one is the rebind.
      return calls === 1
        ? [{ address: "192.88.99.1", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });
    try {
      await expect(
        safeFetch(`http://rebind.invalid:${srv.port}/`, {
          idleTimeoutMs: 300,
          signal: AbortSignal.timeout(3000),
        })
      ).rejects.toThrow();
      expect(loopbackHits).toBe(0);
      expect(calls).toBe(1); // nothing resolved the name a second time
    } finally {
      await close(srv.server);
    }
  });

  it("re-vets every redirect hop by name, through the same resolver", async () => {
    let internalHits = 0;
    const internal = await listen((_req, res) => {
      internalHits++;
      res.writeHead(200).end("INTERNAL-BODY");
    });
    const resolved: string[] = [];
    setHostResolverForTests(async (host) => {
      resolved.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    });
    const redirector = await listen((_req, res) => {
      setPrivateFetchAllowed(false); // hop 1 was allowed; hop 2 meets the guard
      res.writeHead(302, { location: `http://second.invalid:${internal.port}/` }).end();
    });
    try {
      setPrivateFetchAllowed(true);
      await expect(safeFetch(`http://first.invalid:${redirector.port}/`)).rejects.toThrow(/non-public/);
      expect(resolved).toEqual(["first.invalid", "second.invalid"]);
      expect(internalHits).toBe(0);
    } finally {
      await close(internal.server);
      await close(redirector.server);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Transport behaviour the callers rely on.
// ---------------------------------------------------------------------------
describe("safeFetch transport", () => {
  it("lets go of a server that sends headers and then goes silent", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.write("x"); // then nothing, ever
    });
    try {
      setPrivateFetchAllowed(true);
      const started = Date.now();
      const res = await safeFetch(`http://127.0.0.1:${srv.port}/`, { idleTimeoutMs: 200 });
      await expect(res.text()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await close(srv.server);
    }
  });

  it("decodes gzip and reports the final URL after a redirect", async () => {
    const srv = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(301, { location: "/final" }).end();
        return;
      }
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(zlib.gzipSync(Buffer.from("hello, decoded")));
    });
    try {
      setPrivateFetchAllowed(true);
      const res = await safeFetch(`http://127.0.0.1:${srv.port}/start`);
      expect(res.status).toBe(200);
      expect(res.url).toBe(`http://127.0.0.1:${srv.port}/final`);
      expect(await res.text()).toBe("hello, decoded");
    } finally {
      await close(srv.server);
    }
  });

  it("resolves localhost to whichever family the listener is on", async () => {
    // The system resolver may answer ::1 first; the pinned lookup must still
    // hand the socket the whole vetted list so it can fall back to 127.0.0.1.
    const srv = await listen((_req, res) => res.writeHead(200).end("LOCAL"));
    try {
      setPrivateFetchAllowed(true);
      const res = await safeFetch(`http://localhost:${srv.port}/`);
      expect(await res.text()).toBe("LOCAL");
    } finally {
      await close(srv.server);
    }
  });
});
