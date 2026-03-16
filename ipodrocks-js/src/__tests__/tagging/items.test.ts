/**
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  buildTextItem,
  buildBinaryItem,
  serializeItem,
  validateKey,
} from "../../main/tagging/apev2/items";
import { ApeKeyError } from "../../main/tagging/errors";

describe("tagging/apev2/items", () => {
  describe("buildTextItem", () => {
    it("creates UTF-8 text item", () => {
      const item = buildTextItem("Title", "My Track");
      expect(item.key).toBe("Title");
      expect(item.type).toBe("utf8");
      expect(item.value.toString("utf8")).toBe("My Track");
    });

    it("throws on invalid key length", () => {
      expect(() => buildTextItem("A", "x")).toThrow(ApeKeyError);
      expect(() => buildTextItem("x".repeat(256), "x")).toThrow(ApeKeyError);
    });

    it("throws on non-ASCII key", () => {
      expect(() => buildTextItem("Título", "x")).toThrow(ApeKeyError);
      expect(() => buildTextItem("Title\x00", "x")).toThrow(ApeKeyError);
    });
  });

  describe("buildBinaryItem", () => {
    it("creates binary item with filename + null + data", () => {
      const data = Buffer.from([0xff, 0xd8, 0xff]);
      const item = buildBinaryItem("Cover Art (Front)", "cover.jpg", data);
      expect(item.key).toBe("Cover Art (Front)");
      expect(item.type).toBe("binary");
      const parts = item.value.toString("utf8", 0, 10).split("\0");
      expect(parts[0]).toBe("cover.jpg");
      expect(item.value.subarray(10)).toEqual(data);
    });
  });

  describe("serializeItem", () => {
    it("produces correct binary layout for text item", () => {
      const item = buildTextItem("Title", "Hi");
      const buf = serializeItem(item);
      expect(buf.readUInt32LE(0)).toBe(2);
      expect(buf.readUInt32LE(4)).toBe(0);
      expect(buf.toString("ascii", 8, 13)).toBe("Title");
      expect(buf[13]).toBe(0);
      expect(buf.toString("utf8", 14)).toBe("Hi");
    });

    it("produces correct binary layout for binary item", () => {
      const data = Buffer.from([1, 2, 3]);
      const item = buildBinaryItem("Cover Art (Front)", "c.jpg", data);
      const buf = serializeItem(item);
      const valueLen = 5 + 1 + 3;
      expect(buf.readUInt32LE(0)).toBe(valueLen);
      expect(buf.readUInt32LE(4)).toBe(1);
    });
  });

  describe("validateKey", () => {
    it("accepts valid keys", () => {
      expect(() => validateKey("Title")).not.toThrow();
      expect(() => validateKey("AB")).not.toThrow();
      expect(() => validateKey("x".repeat(255))).not.toThrow();
    });

    it("rejects short keys", () => {
      expect(() => validateKey("A")).toThrow(ApeKeyError);
    });

    it("rejects long keys", () => {
      expect(() => validateKey("x".repeat(256))).toThrow(ApeKeyError);
    });

    it("rejects non-printable ASCII", () => {
      expect(() => validateKey("Title\n")).toThrow(ApeKeyError);
      expect(() => validateKey("Title\x7f")).toThrow(ApeKeyError);
    });
  });
});
