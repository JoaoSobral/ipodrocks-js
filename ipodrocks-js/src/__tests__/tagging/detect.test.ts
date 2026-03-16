/**
 * @vitest-environment node
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect } from "vitest";
import { detectMpcVersion } from "../../main/tagging/mpc/detect";
import { MpcFormatError } from "../../main/tagging/errors";
import { MPC_SV7_MAGIC, MPC_SV8_MAGIC } from "../../main/tagging/apev2/constants";

describe("tagging/mpc/detect", () => {
  function makeTempFile(prefix: string, content: Buffer): string {
    const tmp = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.mpc`);
    fs.writeFileSync(tmp, content);
    return tmp;
  }

  it("returns SV7 for MP+ magic", () => {
    const file = makeTempFile("sv7", MPC_SV7_MAGIC);
    try {
      expect(detectMpcVersion(file)).toBe("SV7");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("returns SV8 for MPCK magic", () => {
    const file = makeTempFile("sv8", MPC_SV8_MAGIC);
    try {
      expect(detectMpcVersion(file)).toBe("SV8");
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("throws MpcFormatError for invalid magic", () => {
    const file = makeTempFile("inv", Buffer.from([0x00, 0x01, 0x02, 0x03]));
    try {
      expect(() => detectMpcVersion(file)).toThrow(MpcFormatError);
      expect(() => detectMpcVersion(file)).toThrow(/Not a valid Musepack/);
    } finally {
      fs.unlinkSync(file);
    }
  });
});
