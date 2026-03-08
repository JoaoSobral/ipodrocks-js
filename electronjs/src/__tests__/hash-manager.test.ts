import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

import { AppDatabase } from "../main/database/database";
import { HashManager } from "../main/library/hash-manager";

describe("HashManager", () => {
  let appDb: AppDatabase;
  let hm: HashManager;
  let tmpDir: string;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.initialize();
    hm = new HashManager(appDb.getConnection());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-test-"));
  });

  afterEach(() => {
    appDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("computeFileHash", () => {
    it("returns SHA-256 matching expected digest", () => {
      const content = "hello world\n";
      const filePath = path.join(tmpDir, "test.txt");
      fs.writeFileSync(filePath, content);

      const expected = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      expect(hm.computeFileHash(filePath)).toBe(expected);
    });

    it("returns empty string for non-existent file", () => {
      expect(hm.computeFileHash("/nonexistent/file.txt")).toBe("");
    });
  });

  describe("computeMetadataHash", () => {
    it("same metadata produces the same hash", () => {
      const meta = { artist: "Band", album: "LP", title: "Track", genre: "Rock" };
      const h1 = hm.computeMetadataHash(meta);
      const h2 = hm.computeMetadataHash(meta);
      expect(h1).toBe(h2);
    });

    it("different metadata produces different hashes", () => {
      const h1 = hm.computeMetadataHash({
        artist: "A",
        album: "B",
        title: "C",
        genre: "D",
      });
      const h2 = hm.computeMetadataHash({
        artist: "X",
        album: "Y",
        title: "Z",
        genre: "W",
      });
      expect(h1).not.toBe(h2);
    });

    it("normalizes empty fields to defaults", () => {
      const h1 = hm.computeMetadataHash({
        artist: "",
        album: "",
        title: "T",
        genre: "",
      });
      const h2 = hm.computeMetadataHash({
        artist: "Unknown Artist",
        album: "Unknown Album",
        title: "T",
        genre: "Unknown Genre",
      });
      expect(h1).toBe(h2);
    });
  });

  describe("storeHash / getHash", () => {
    it("round-trips a content hash record", () => {
      const record = {
        filePath: "/music/song.flac",
        contentHash: "aaa",
        metadataHash: "bbb",
        fileSize: 12345,
        lastModified: new Date().toISOString(),
        hashType: "sha256",
      };

      expect(hm.storeHash(record)).toBe(true);

      const retrieved = hm.getHash("/music/song.flac");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.contentHash).toBe("aaa");
      expect(retrieved!.metadataHash).toBe("bbb");
      expect(retrieved!.fileSize).toBe(12345);
    });

    it("returns null for unknown path", () => {
      expect(hm.getHash("/nope")).toBeNull();
    });

    it("upserts on duplicate file path", () => {
      const base = {
        filePath: "/music/dup.flac",
        contentHash: "v1",
        metadataHash: "m1",
        fileSize: 100,
        lastModified: new Date().toISOString(),
        hashType: "sha256",
      };

      hm.storeHash(base);
      hm.storeHash({ ...base, contentHash: "v2" });

      const retrieved = hm.getHash("/music/dup.flac");
      expect(retrieved!.contentHash).toBe("v2");
    });
  });
});
