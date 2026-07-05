/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { Readable, Writable } from "stream";
import { pipeline } from "stream/promises";
import { byteCapTransform } from "../main/utils/capped-stream";

async function pipeChunks(chunks: Buffer[], maxBytes: number): Promise<Buffer> {
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(Buffer.from(chunk));
      cb();
    },
  });
  await pipeline(Readable.from(chunks), byteCapTransform(maxBytes), sink);
  return Buffer.concat(out);
}

describe("byteCapTransform", () => {
  it("passes data through unchanged when under the cap", async () => {
    const result = await pipeChunks([Buffer.from("hello "), Buffer.from("world")], 1000);
    expect(result.toString()).toBe("hello world");
  });

  it("aborts the pipeline once the cap is exceeded", async () => {
    const chunks = [Buffer.alloc(6), Buffer.alloc(6)]; // 12 bytes, cap 10
    await expect(pipeChunks(chunks, 10)).rejects.toThrow(/exceeded maximum size/i);
  });

  it("allows data exactly at the cap", async () => {
    const result = await pipeChunks([Buffer.alloc(10)], 10);
    expect(result.length).toBe(10);
  });
});
