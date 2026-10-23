/**
 * @vitest-environment node
 *
 * CVE-2026-111497 ("Node2Shell"): Node's Brotli decoder, fixed in 22.23.4 /
 * 24.22.1 / 26.12.1. The Electron build bundles its own Node and no Electron
 * release carried the fix yet, so the two places an attacker could hand us
 * Brotli stop decoding it at all:
 *
 * 1. `safeFetch` — a feed URL is client-chosen, so the server behind it is too.
 *    It no longer asks for `br` and refuses a body that arrives as `br` anyway.
 * 2. `jsonBody()` — body-parser 2 decodes `Content-Encoding: br` request bodies,
 *    and `/api/auth` parses one before sign-in. Compressed bodies get 415.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import * as net from "net";
import * as zlib from "zlib";
import express from "express";

import { safeFetch, setPrivateFetchAllowed } from "@main/utils/safe-fetch";
import { jsonBody } from "../../server/http";

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
});

describe("safeFetch never decodes Brotli", () => {
  it("does not advertise br, even when the caller asks for it", async () => {
    let seen: string | undefined;
    const srv = await listen((req, res) => {
      seen = req.headers["accept-encoding"];
      res.writeHead(200).end("ok");
    });
    try {
      setPrivateFetchAllowed(true);
      const res = await safeFetch(`http://127.0.0.1:${srv.port}/`, {
        headers: { "accept-encoding": "br" },
      });
      await res.text();
      expect(seen).toBe("gzip, deflate");
    } finally {
      await close(srv.server);
    }
  });

  it("refuses a br body the server sends unasked, in any spelling", async () => {
    for (const encoding of ["br", "BR", "gzip, br"]) {
      const srv = await listen((_req, res) => {
        res.writeHead(200, { "content-encoding": encoding });
        res.end(zlib.brotliCompressSync(Buffer.from("payload")));
      });
      try {
        setPrivateFetchAllowed(true);
        await expect(safeFetch(`http://127.0.0.1:${srv.port}/`)).rejects.toThrow(/Brotli/);
      } finally {
        await close(srv.server);
      }
    }
  });

  it("still decodes gzip (control)", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(zlib.gzipSync(Buffer.from("payload")));
    });
    try {
      setPrivateFetchAllowed(true);
      const res = await safeFetch(`http://127.0.0.1:${srv.port}/`);
      expect(await res.text()).toBe("payload");
    } finally {
      await close(srv.server);
    }
  });
});

describe("jsonBody refuses compressed request bodies", () => {
  async function post(headers: Record<string, string>, body: Buffer): Promise<number> {
    const app = express();
    app.post("/", jsonBody("64kb"), (req, res) => res.json(req.body));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
      return res.status;
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r(undefined)));
    }
  }

  const json = Buffer.from(JSON.stringify({ username: "x", password: "y" }));

  it("answers 415 to a br body", async () => {
    expect(await post({ "content-encoding": "br" }, zlib.brotliCompressSync(json))).toBe(415);
  });

  it("answers 415 to gzip as well — nothing of ours compresses a request", async () => {
    expect(await post({ "content-encoding": "gzip" }, zlib.gzipSync(json))).toBe(415);
  });

  it("parses an uncompressed body (control)", async () => {
    expect(await post({}, json)).toBe(200);
  });
});
