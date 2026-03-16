/**
 * Detect Musepack SV7 vs SV8 from file magic bytes.
 */

import * as fs from "fs";
import { MPC_SV7_MAGIC, MPC_SV8_MAGIC } from "../apev2/constants";
import { MpcFormatError } from "../errors";
import type { MpcVersion } from "../apev2/types";

export function detectMpcVersion(filePath: string): MpcVersion {
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.allocUnsafe(4);
  try {
    fs.readSync(fd, header, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (header.subarray(0, 3).equals(MPC_SV7_MAGIC)) return "SV7";
  if (header.subarray(0, 4).equals(MPC_SV8_MAGIC)) return "SV8";

  throw new MpcFormatError(`Not a valid Musepack file: ${filePath}`);
}
