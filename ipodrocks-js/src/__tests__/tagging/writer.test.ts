/**
 * @vitest-environment node
 * Integration test: write tags to minimal MPC, read back with music-metadata.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect } from "vitest";
import { writeTags } from "../../main/tagging/writer";
import { parseFile } from "music-metadata";
import { MPC_SV7_MAGIC } from "../../main/tagging/apev2/constants";

describe("tagging/writer integration", () => {
  it("writes tags and they are readable by music-metadata", async () => {
    const audio = Buffer.concat([
      MPC_SV7_MAGIC,
      Buffer.alloc(200, 0),
    ]);
    const tmp = path.join(
      os.tmpdir(),
      `mpc_write_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`
    );
    fs.writeFileSync(tmp, audio);

    try {
      await writeTags(tmp, {
        title: "Test Title",
        artist: "Test Artist",
        album: "Test Album",
        year: "2024",
        track: "3",
      });

      const meta = await parseFile(tmp);
      expect(meta.common.title).toBe("Test Title");
      expect(meta.common.artist).toBe("Test Artist");
      expect(meta.common.album).toBe("Test Album");
      expect(meta.common.year).toBe(2024);
      expect(meta.common.track?.no).toBe(3);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  });

  it("handles empty tags by stripping only", async () => {
    const audio = Buffer.concat([MPC_SV7_MAGIC, Buffer.alloc(50, 0)]);
    const tmp = path.join(
      os.tmpdir(),
      `mpc_empty_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`
    );
    fs.writeFileSync(tmp, audio);

    try {
      const result = await writeTags(tmp, {});
      expect(result.itemCount).toBe(0);
      expect(result.bytesWritten).toBe(audio.length);
      const onDisk = fs.readFileSync(tmp);
      expect(onDisk.equals(audio)).toBe(true);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  });
});
