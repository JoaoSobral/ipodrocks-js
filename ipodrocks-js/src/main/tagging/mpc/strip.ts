/**
 * Strip existing APEv2 and ID3v1 tags from MPC file, return pure audio bytes.
 */

import * as fs from "fs";
import { locateApeBlock, endWithoutId3v1 } from "../apev2/locate";

export function readAudioOnly(filePath: string): Buffer {
  const full = fs.readFileSync(filePath);
  const loc = locateApeBlock(full);
  const end = loc ? loc.audioEnd : endWithoutId3v1(full);
  return full.subarray(0, end);
}
