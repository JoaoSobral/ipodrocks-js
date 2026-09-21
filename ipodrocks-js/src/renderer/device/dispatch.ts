/**
 * One RPC verb -> one `fs-ops` call.
 *
 * Kept apart from both the worker and the socket so it can be driven directly
 * in a test: the e2e specs seed an OPFS tree and call this, which exercises the
 * same File System Access code path a real picked folder takes.
 *
 * Binary payloads cross as base64. They are small by construction — a Rockbox
 * index read, a `.m3u`, a rating patch — because anything large goes through
 * the data plane instead.
 */
import type { DeviceRpcVerb } from "@shared/device-rpc";

import {
  DeviceOpError,
  opFreeSpace,
  opListTree,
  opMkdir,
  opPatch,
  opPull,
  opPush,
  opReadFile,
  opReadRange,
  opReaddir,
  opRename,
  opRm,
  opRmdir,
  opStat,
  opUnlink,
  opWriteFile,
} from "./fs-ops";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit somewhere
  // around a hundred thousand bytes, and the Rockbox index is megabytes.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function dispatchDeviceRpc(
  root: FileSystemDirectoryHandle,
  verb: DeviceRpcVerb,
  args: unknown[]
): Promise<unknown> {
  switch (verb) {
    case "stat":
      return opStat(root, String(args[0]));
    case "readdir":
      return opReaddir(root, String(args[0]));
    case "listTree":
      return opListTree(root, String(args[0]));
    case "readFile":
      return toBase64(await opReadFile(root, String(args[0])));
    case "readRange":
      return toBase64(
        await opReadRange(root, String(args[0]), Number(args[1]), Number(args[2]))
      );
    case "writeFile":
      return opWriteFile(root, String(args[0]), fromBase64(String(args[1])));
    case "patch":
      return opPatch(
        root,
        String(args[0]),
        (args[1] as { offset: number; bytes: string }[]).map((r) => ({
          offset: r.offset,
          bytes: fromBase64(r.bytes),
        }))
      );
    case "mkdir":
      return opMkdir(root, String(args[0]), args[1] as { recursive?: boolean });
    case "unlink":
      return opUnlink(root, String(args[0]));
    case "rmdir":
      return opRmdir(root, String(args[0]));
    case "rm":
      return opRm(root, String(args[0]), args[1] as { recursive?: boolean; force?: boolean });
    case "rename":
      return opRename(root, String(args[0]), String(args[1]));
    case "freeSpace":
      return opFreeSpace();
    case "pull":
      return opPull(root, String(args[0]), String(args[1]));
    case "push":
      return opPush(root, String(args[0]), String(args[1]));
    default:
      throw new DeviceOpError(`Unknown device verb: ${String(verb)}`, "EINVAL");
  }
}
