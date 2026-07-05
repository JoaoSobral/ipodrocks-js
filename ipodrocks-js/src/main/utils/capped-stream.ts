import { Transform } from "stream";

/**
 * Hard ceiling on a single media download. Podcast episodes and audiobook
 * chapters come from feed-controlled URLs, so without a cap a hostile or
 * broken feed could stream unbounded data and fill the user's disk. 2 GiB is
 * far above any real spoken-word file.
 */
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * A pass-through stream that aborts the pipeline once more than `maxBytes`
 * have flowed through it. Insert it between the network body and the file
 * sink: `pipeline(body, byteCapTransform(), dest)`.
 */
export function byteCapTransform(maxBytes: number = MAX_DOWNLOAD_BYTES): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new Error(`Download exceeded maximum size of ${maxBytes} bytes`));
        return;
      }
      cb(null, chunk);
    },
  });
}
