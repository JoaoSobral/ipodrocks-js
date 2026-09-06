/**
 * Ejecting a device from inside iPodRocks, instead of leaving for Finder.
 *
 * macOS and Linux only. Windows has no dependable command-line eject — the
 * usual suggestions (`mountvol /p`, a PowerShell `Shell.Application` verb) are
 * either privileged or silently unreliable — so it is refused outright rather
 * than shipped as a button that mostly fails.
 */

import { execFile } from "child_process";
import * as fs from "fs";

/** Same shape as the USB enumeration timeout: a spawn that hangs is a failure. */
const EJECT_TIMEOUT_MS = 20_000;

export class EjectUnsupportedError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Ejecting is not supported on ${platform}`);
    this.name = "EjectUnsupportedError";
  }
}

export interface EjectCommand {
  command: string;
  args: string[];
}

export type EjectResult = { ok: true; command: string } | { ok: false; reason: string };

/**
 * Build the platform's eject invocation.
 *
 * `platform` is injected (defaulting to the host) so the Linux branch is
 * testable from a macOS CI runner, matching `sanitizeMountPath` in
 * `path-allowlist.ts`.
 *
 * Everything is returned as an argv array and spawned through `execFile` with
 * no shell, so a mount path containing spaces, quotes or a semicolon is passed
 * through verbatim and can never be interpreted as shell syntax.
 */
export function buildEjectCommand(
  mountPath: string,
  blockDevice: string | null,
  platform: NodeJS.Platform = process.platform,
): EjectCommand {
  if (platform === "darwin") {
    // `diskutil eject` unmounts every volume on the disk and spins it down —
    // exactly what Finder's eject button does.
    return { command: "diskutil", args: ["eject", mountPath] };
  }
  if (platform === "linux") {
    // udisks is what the desktop itself uses, so it needs no privileges and the
    // file manager learns about the unmount. It addresses volumes by block
    // device, not mount point, hence `resolveBlockDevice`.
    if (blockDevice) {
      return { command: "udisksctl", args: ["unmount", "-b", blockDevice] };
    }
    return { command: "umount", args: [mountPath] };
  }
  throw new EjectUnsupportedError(platform);
}

/** True when this platform has an eject path at all. */
export function isEjectSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Undo the octal escaping the kernel applies to whitespace and backslashes in
 * the mount-point field of /proc/mounts. A volume called "My iPod" is written
 * `/media/pedro/My\040iPod`, so skipping this makes every such device
 * unresolvable.
 */
export function unescapeMountField(field: string): string {
  return field.replace(/\\(040|011|012|134)/g, (_m, code: string) => {
    switch (code) {
      case "040":
        return " ";
      case "011":
        return "\t";
      case "012":
        return "\n";
      default:
        return "\\";
    }
  });
}

/**
 * Find the block device backing a mount point, by reading /proc/mounts rather
 * than spawning `findmnt` — one less external dependency, and directly
 * testable against a fixture.
 *
 * Returns null when the path is not a mount point at all, which is also the
 * signal `buildEjectCommand` uses to fall back to plain `umount`.
 */
export function resolveBlockDevice(
  mountPath: string,
  procMountsContent?: string,
): string | null {
  let content = procMountsContent;
  if (content === undefined) {
    try {
      content = fs.readFileSync("/proc/mounts", "utf8");
    } catch {
      return null;
    }
  }

  // Later entries shadow earlier ones when a path is mounted over, so the last
  // match is the live filesystem.
  let found: string | null = null;
  for (const line of content.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const source = unescapeMountField(parts[0]);
    const target = unescapeMountField(parts[1]);
    if (target === mountPath && source.startsWith("/dev/")) {
      found = source;
    }
  }
  return found;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: EJECT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // Tool diagnostics land on stderr; the Error's own message is just
          // "Command failed", which tells the user nothing.
          const detail = String(stderr || stdout || err.message).trim();
          reject(new Error(detail || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Eject the volume mounted at `mountPath`.
 *
 * Never throws: a failure resolves to `{ ok: false, reason }` so the IPC layer
 * can report why, in the same spirit as `listUsbDevices()`.
 *
 * On Linux a `udisksctl` failure retries once with `umount`, which covers a
 * system with no udisks daemon (a bare window manager, a container) as well as
 * a volume udisks does not consider removable.
 */
export async function ejectDevice(
  mountPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<EjectResult> {
  if (!isEjectSupported(platform)) {
    return {
      ok: false,
      reason: "Ejecting from iPodRocks is not supported on this platform yet.",
    };
  }

  const blockDevice = platform === "linux" ? resolveBlockDevice(mountPath) : null;
  const primary = buildEjectCommand(mountPath, blockDevice, platform);

  try {
    await run(primary.command, primary.args);
    return { ok: true, command: primary.command };
  } catch (err) {
    const firstReason = err instanceof Error ? err.message : String(err);

    if (platform === "linux" && blockDevice) {
      try {
        await run("umount", [mountPath]);
        return { ok: true, command: "umount" };
      } catch (fallbackErr) {
        const second =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        return { ok: false, reason: `${firstReason} (umount also failed: ${second})` };
      }
    }

    return { ok: false, reason: firstReason };
  }
}
