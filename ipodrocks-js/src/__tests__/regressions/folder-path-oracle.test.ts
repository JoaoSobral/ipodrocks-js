/**
 * @vitest-environment node
 *
 * Regression — `validateFolderPath()` was a file-existence oracle for the
 * whole server.
 *
 * It `stat`ed the path before checking the allowlist, so `app:listDirectory`
 * (and `library:addFolder`, `library:scan`, `shadow:create`) told any web
 * client "not a directory", "does not exist" or "outside allowed directories"
 * for any path at all — enough to locate `/etc/ipodrocks/server.env` or the
 * server database without being allowed to browse there. Everything outside
 * the roots must now read exactly like a path that does not exist.
 *
 * Drives the real function (`validate-path.test.ts` tests a local replica).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FOLDER_PATH_UNAVAILABLE,
  validateFolderPath,
} from "../../main/ipc/common";
import { listDirectory } from "../../main/ipc/app";
import { validateFolderPathForTool } from "../../main/assistant/tool-helpers";

let inside: string;
let outside: string;

beforeAll(() => {
  // Under $HOME so the allowlist admits it.
  inside = fs.mkdtempSync(path.join(os.homedir(), ".ipr-vfp-"));
  fs.mkdirSync(path.join(inside, "dir"));
  fs.writeFileSync(path.join(inside, "file.txt"), "x");

  // Windows has no path outside the roots (every drive letter is one), and the
  // suite that uses these is skipped there — so do not build them.
  if (process.platform === "win32") return;

  // Outside every root on macOS and Linux alike.
  outside = fs.mkdtempSync(path.join("/", "tmp", "ipr-vfp-out-"));
  fs.mkdirSync(path.join(outside, "dir"));
  fs.writeFileSync(path.join(outside, "file.txt"), "x");
  fs.symlinkSync(path.join(outside, "dir"), path.join(inside, "link-out"));
  fs.symlinkSync(path.join(outside, "file.txt"), path.join(inside, "link-out-file"));
});

afterAll(() => {
  fs.rmSync(inside, { recursive: true, force: true });
  if (outside) fs.rmSync(outside, { recursive: true, force: true });
});

function err(p: string): string | undefined {
  const r = validateFolderPath(p);
  return "error" in r ? r.error : undefined;
}

describe.skipIf(process.platform === "win32")("outside the roots, nothing is disclosed", () => {
  it("an existing directory, an existing file and a missing path answer identically", () => {
    const answers = [
      path.join(outside, "dir"),
      path.join(outside, "file.txt"),
      path.join(outside, "no-such-thing"),
      "/etc",
      "/definitely/not/here",
    ].map(err);
    expect(new Set(answers)).toEqual(new Set([FOLDER_PATH_UNAVAILABLE]));
  });

  it("a symlink inside the home directory pointing outside is refused the same way", () => {
    expect(err(path.join(inside, "link-out"))).toBe(FOLDER_PATH_UNAVAILABLE);
    expect(err(path.join(inside, "link-out-file"))).toBe(FOLDER_PATH_UNAVAILABLE);
  });

  it("app:listDirectory and the Rocksy helper give the same answer", () => {
    expect(listDirectory(path.join(outside, "file.txt")).error).toBe(FOLDER_PATH_UNAVAILABLE);
    expect(listDirectory(path.join(outside, "dir")).error).toBe(FOLDER_PATH_UNAVAILABLE);
    const tool = validateFolderPathForTool(path.join(outside, "dir"));
    expect("error" in tool && tool.error).toBe(FOLDER_PATH_UNAVAILABLE);
  });
});

describe("inside the roots, the validator still works", () => {
  it("accepts a directory and returns its real path", () => {
    const r = validateFolderPath(`  ${path.join(inside, "dir")}  `);
    expect(r).toEqual({ path: fs.realpathSync(path.join(inside, "dir")) });
  });

  it("control: a file inside the roots is still reported as not a directory", () => {
    expect(err(path.join(inside, "file.txt"))).toBe("Path is not a directory");
    expect(err(path.join(inside, "missing"))).toBe(FOLDER_PATH_UNAVAILABLE);
  });

  it("rejects empty and non-string input", () => {
    expect(err("")).toBe("Invalid path");
    expect(err(42 as unknown as string)).toBe("Invalid path");
    expect(err(`${inside}\0/x`)).toBe("Invalid path");
  });
});
