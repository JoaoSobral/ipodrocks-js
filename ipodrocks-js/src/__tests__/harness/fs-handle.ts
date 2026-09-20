/**
 * A `FileSystemDirectoryHandle` over a real directory, for Node.
 *
 * The browser-side device code is written against the File System Access API,
 * which does not exist under vitest. This shim implements the handful of
 * members `fs-ops.ts` actually touches — `getFileHandle`, `getDirectoryHandle`,
 * `removeEntry`, `values()`, `getFile()` and `createWritable()` — so the *real*
 * dispatcher can be driven in a unit test.
 *
 * It is make-believe, and that is exactly why the e2e specs run the same
 * dispatcher against a genuine OPFS handle in Chromium. This proves the logic;
 * those prove the shim is honest about the API.
 *
 * One behaviour is deliberately faithful rather than convenient:
 * `getDirectoryHandle(name)` matches **one exact name**, with no NFC/NFD
 * forgiveness — because that is the property `RemoteDeviceFs` exists to work
 * around, and a shim that quietly resolved either form would make the test
 * that matters pass for the wrong reason.
 */
import * as fs from "fs";
import * as path from "path";

class NotFound extends Error {
  override name = "NotFoundError";
}
class TypeMismatch extends Error {
  override name = "TypeMismatchError";
}
class NotEmpty extends Error {
  override name = "InvalidModificationError";
}

interface WriteChunk {
  type: "write";
  position: number;
  data: ArrayBuffer | Uint8Array;
}

function toBuffer(data: ArrayBuffer | Uint8Array | WriteChunk): Buffer {
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(new Uint8Array(data as ArrayBuffer));
}

function makeFileHandle(filePath: string, name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    async getFile() {
      const stat = fs.statSync(filePath);
      const bytes = fs.readFileSync(filePath);
      return {
        size: stat.size,
        lastModified: Math.floor(stat.mtimeMs),
        name,
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer;
        },
        slice(start: number, end: number) {
          const part = bytes.subarray(start, Math.min(end, bytes.length));
          return {
            async arrayBuffer() {
              return part.buffer.slice(
                part.byteOffset,
                part.byteOffset + part.byteLength
              ) as ArrayBuffer;
            },
          };
        },
      } as unknown as File;
    },
    async createWritable(options?: { keepExistingData?: boolean }) {
      // Chrome writes through a `<name>.crswap` sibling and rewrites the file
      // wholesale, which is why `keepExistingData` is the difference between a
      // patch and a truncate. Reproduced, because getting that wrong on a
      // checksum-less index file is unrecoverable.
      let contents =
        options?.keepExistingData && fs.existsSync(filePath)
          ? fs.readFileSync(filePath)
          : Buffer.alloc(0);
      let cursor = 0;
      return {
        async write(data: ArrayBuffer | Uint8Array | WriteChunk) {
          if (data && typeof data === "object" && "type" in data) {
            const chunk = data as WriteChunk;
            const bytes = toBuffer(chunk.data);
            const end = chunk.position + bytes.length;
            if (end > contents.length) {
              contents = Buffer.concat([
                contents,
                Buffer.alloc(end - contents.length),
              ]);
            }
            bytes.copy(contents, chunk.position);
            cursor = end;
            return;
          }
          const bytes = toBuffer(data);
          const end = cursor + bytes.length;
          if (end > contents.length) {
            contents = Buffer.concat([contents, Buffer.alloc(end - contents.length)]);
          }
          bytes.copy(contents, cursor);
          cursor = end;
        },
        async close() {
          fs.writeFileSync(filePath, contents);
        },
        async abort() {
          /* the swap file is simply dropped */
        },
      } as unknown as FileSystemWritableFileStream;
    },
  } as unknown as FileSystemFileHandle;
}

export function makeDirectoryHandle(
  dirPath: string,
  name = path.basename(dirPath)
): FileSystemDirectoryHandle {
  const handle = {
    kind: "directory",
    name,
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      const target = path.join(dirPath, child);
      if (!fs.existsSync(target)) {
        if (!options?.create) throw new NotFound(child);
        fs.mkdirSync(target);
      } else if (!fs.statSync(target).isDirectory()) {
        throw new TypeMismatch(child);
      }
      return makeDirectoryHandle(target, child);
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      const target = path.join(dirPath, child);
      if (!fs.existsSync(target)) {
        if (!options?.create) throw new NotFound(child);
        fs.writeFileSync(target, Buffer.alloc(0));
      } else if (fs.statSync(target).isDirectory()) {
        throw new TypeMismatch(child);
      }
      return makeFileHandle(target, child);
    },
    async removeEntry(child: string, options?: { recursive?: boolean }) {
      const target = path.join(dirPath, child);
      if (!fs.existsSync(target)) throw new NotFound(child);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        if (!options?.recursive && fs.readdirSync(target).length > 0) {
          throw new NotEmpty(child);
        }
        fs.rmSync(target, { recursive: true, force: true });
        return;
      }
      fs.unlinkSync(target);
    },
    async *values() {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        yield entry.isDirectory()
          ? makeDirectoryHandle(path.join(dirPath, entry.name), entry.name)
          : makeFileHandle(path.join(dirPath, entry.name), entry.name);
      }
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}
