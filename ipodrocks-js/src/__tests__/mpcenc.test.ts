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

const okResult = { status: 0, error: undefined, stdout: "", stderr: "", pid: 1, output: [], signal: null };
const noentResult = { status: null, error: new Error("ENOENT"), stdout: "", stderr: "", pid: 0, output: [], signal: null };
const nonZeroResult = { status: 1, error: undefined, stdout: "", stderr: "", pid: 1, output: [], signal: null };
const whichOkResult = { status: 0, error: undefined, stdout: "/opt/homebrew/bin/mpcenc\n", stderr: "", pid: 2, output: [], signal: null };

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

  it("falls back to which/where when mpcenc exits non-zero and which succeeds", async () => {
    spawnSyncMock.mockReturnValueOnce(nonZeroResult).mockReturnValueOnce(whichOkResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    expect(isMpcencAvailable()).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("spawns with PATH that includes /opt/homebrew/bin", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    spawnSyncMock.mockReturnValue(okResult);
    const { isMpcencAvailable } = await import("../main/utils/mpcenc");
    isMpcencAvailable();
    const usedEnv = spawnSyncMock.mock.calls[0][2]?.env as NodeJS.ProcessEnv | undefined;
    expect(usedEnv?.PATH).toContain("/opt/homebrew/bin");
  });
});
