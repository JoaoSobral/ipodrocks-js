/**
 * Strip existing APEv2 and ID3v1 tags from MPC file, return pure audio bytes.
 */

import * as fs from "fs";
import {
  APE_PREAMBLE,
  APE_FOOTER_SIZE,
  APE_HEADER_SIZE,
  ID3V1_MAGIC,
  ID3V1_SIZE,
} from "../apev2/constants";

export function readAudioOnly(filePath: string): Buffer {
  const full = fs.readFileSync(filePath);
  let end = full.byteLength;

  if (end >= ID3V1_SIZE) {
    const id3Start = end - ID3V1_SIZE;
    if (full.subarray(id3Start, id3Start + 3).equals(ID3V1_MAGIC)) {
      end -= ID3V1_SIZE;
    }
  }

  if (end >= APE_FOOTER_SIZE) {
    const footerStart = end - APE_FOOTER_SIZE;
    const maybePreamble = full.subarray(footerStart, footerStart + 8);

    if (maybePreamble.equals(APE_PREAMBLE)) {
      const tagSize = full.readUInt32LE(footerStart + 12);
      const blockSize =
        tagSize > APE_FOOTER_SIZE ? tagSize + APE_HEADER_SIZE : tagSize;
      const blockStart = end - blockSize;
      end = Math.max(0, blockStart);
    }
  }

  return full.subarray(0, end);
}
