/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const isWindows = process.platform === "win32";

const okResult = { status: 0, error: undefined, stdout: "", stderr: "", pid: 1, output: [], signal: null };
const noentResult = { status: null, error: new Error("ENOENT"), stdout: "", stderr: "", pid: 0, output: [], signal: null };
const nonZeroResult = { status: 1, error: undefined, stdout: "", stderr: "", pid: 1, output: [], signal: null };

describe("isMpcencAvailable", () => {
  it("returns true when mpcenc --version exits 0", async () => {
    spawnSyncMock.mockReturnValue(okResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    expect(isMpcencAvailable()).toBe(true);
  });

  it("returns false when spawnSync returns an error", async () => {
    spawnSyncMock.mockReturnValue(noentResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    expect(isMpcencAvailable()).toBe(false);
  });

  // mpcenc 1.30.1 exits 1 for --version. The old fallback then ran `which`,
  // which the distroless server image does not have, and reported a working
  // mpcenc as missing.
  it("returns true when mpcenc exits non-zero, without asking which/where", async () => {
    spawnSyncMock.mockReturnValue(nonZeroResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    expect(isMpcencAvailable()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  // getEncoderEnv() only prepends macOS/Linux paths; on Windows PATH is passed through as-is.
  // mpcenc.ts also freezes env in SPAWN_OPTS at first import, so this only asserts non-Windows behavior.
  it.skipIf(isWindows)("spawns with PATH that includes /opt/homebrew/bin", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    spawnSyncMock.mockReturnValue(okResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    isMpcencAvailable();
    const usedEnv = spawnSyncMock.mock.calls[0][2]?.env as NodeJS.ProcessEnv | undefined;
    expect(usedEnv?.PATH).toContain("/opt/homebrew/bin");
  });
});
