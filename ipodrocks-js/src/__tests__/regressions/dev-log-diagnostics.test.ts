/**
 * The developer log and the compare diagnostics behind it.
 *
 * The field report that prompted both: a remote device check said "0 synced,
 * 2921 to sync, 0 orphans" for a player that held the tracks. A count cannot
 * say whether the files were missing or found and refused, and that was the
 * whole question. These pin that the log answers it — and that, while off, it
 * records nothing and costs no formatting.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_LOG_CAPACITY,
  clearDevLog,
  devLog,
  readDevLog,
  setDevLogEnabledForTests,
} from "../../main/utils/dev-log";
import { logCompareDiagnostics } from "../../main/sync/compare-diagnostics";
import { compareLibraries } from "../../main/sync/name-size-sync";
import { remapTrackMapToShadow } from "../../main/ipc/common";

afterEach(() => {
  clearDevLog();
  setDevLogEnabledForTests(null);
  vi.restoreAllMocks();
});

function messages(): string[] {
  return readDevLog(0).entries.map((e) => `[${e.scope}] ${e.message}`);
}

describe("devLog", () => {
  it("records nothing and never calls the formatter while off", () => {
    setDevLogEnabledForTests(false);
    const format = vi.fn(() => "expensive");
    devLog("x", format);
    expect(format).not.toHaveBeenCalled();
    setDevLogEnabledForTests(true);
    expect(readDevLog(0).entries).toHaveLength(0);
  });

  it("is off unless the env flag is exactly 1", () => {
    const prev = process.env.IPODROCKS_DEV_LOGS;
    try {
      process.env.IPODROCKS_DEV_LOGS = "true";
      expect(readDevLog(0).enabled).toBe(false);
      process.env.IPODROCKS_DEV_LOGS = "1";
      expect(readDevLog(0).enabled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.IPODROCKS_DEV_LOGS;
      else process.env.IPODROCKS_DEV_LOGS = prev;
    }
  });

  it("pages by seq and stays bounded", () => {
    setDevLogEnabledForTests(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < DEV_LOG_CAPACITY + 10; i++) devLog("x", `line ${i}`);
    const all = readDevLog(0, 1_000_000);
    // Capped page, oldest first, and the oldest ten have been dropped.
    expect(all.entries.length).toBeLessThanOrEqual(1000);
    expect(all.entries[0].message).toBe("line 10");
    const tail = readDevLog(all.lastSeq - 2);
    expect(tail.entries.map((e) => e.message)).toEqual([
      `line ${DEV_LOG_CAPACITY + 8}`,
      `line ${DEV_LOG_CAPACITY + 9}`,
    ]);
  });

  it("survives a formatter that throws", () => {
    setDevLogEnabledForTests(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      devLog("x", () => {
        throw new Error("boom");
      })
    ).not.toThrow();
    expect(messages()[0]).toContain("boom");
  });
});

describe("compare diagnostics", () => {
  const content = "/ipodrocks-web/1/Music";
  const libPath = "/shadow/A/B/01 T.mp3";
  const destMap = { [libPath]: "A/B/01 T.mp3" };
  // The transcode on the device: 3 MB, copied yesterday, mtime unsettable.
  const device = {
    [`${content}/A/B/01 T.mp3`]: { file_size: 3_000_000, mtime: Date.now() - 86_400_000 },
  };
  const libMtime = Date.now() - 7 * 86_400_000;

  it("names a file found and refused on size — the remote shadow bug", () => {
    setDevLogEnabledForTests(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    // What the remap used to hand the compare: the source FLAC's size.
    const expectedSizes = { [libPath]: 30_000_000 };
    const result = compareLibraries(destMap, expectedSizes, content, device, {
      libraryExpectedMtimes: { [libPath]: libMtime },
    });
    expect(result.missingTracks.size).toBe(1);
    expect(result.extras).toHaveLength(0);

    logCompareDiagnostics({
      label: "check:music",
      destMap,
      expectedSizes,
      expectedMtimes: { [libPath]: libMtime },
      deviceContentPath: content,
      deviceFilesMap: device,
      result,
      profileCodecExt: null,
    });
    const lines = messages();
    expect(lines.some((l) => l.includes("synced 0") && l.includes("to sync 1"))).toBe(true);
    expect(lines.some((l) => l.includes("found, size differs ×1"))).toBe(true);
    expect(
      lines.some((l) => l.includes("size 3000000 vs expected 30000000"))
    ).toBe(true);
  });

  it("says when a file is simply not there", () => {
    setDevLogEnabledForTests(true);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = compareLibraries(destMap, { [libPath]: 3_000_000 }, content, {});
    logCompareDiagnostics({
      label: "check:music",
      destMap,
      expectedSizes: { [libPath]: 3_000_000 },
      expectedMtimes: {},
      deviceContentPath: content,
      deviceFilesMap: {},
      result,
      profileCodecExt: null,
    });
    expect(messages().some((l) => l.includes("not on device ×1"))).toBe(true);
  });

  it("does no work while off", () => {
    setDevLogEnabledForTests(false);
    const result = compareLibraries(destMap, {}, content, device);
    // A getter that throws proves the inputs are never read.
    const trap = new Proxy({}, { get: () => { throw new Error("read while off"); } });
    expect(() =>
      logCompareDiagnostics({
        label: "x",
        destMap: trap as Record<string, string>,
        expectedSizes: trap as Record<string, number>,
        expectedMtimes: {},
        deviceContentPath: content,
        deviceFilesMap: trap as typeof device,
        result,
        profileCodecExt: null,
      })
    ).not.toThrow();
  });
});

describe("the shadow remap carries the transcode's size", () => {
  it("replaces the source size, and the compare then accepts the device file", () => {
    const remapped = remapTrackMapToShadow(
      { "/music/A/B/01 T.flac": { id: 1, path: "/music/A/B/01 T.flac", fileSize: 30_000_000 } },
      new Map([[1, { path: "/shadow/A/B/01 T.mp3", fileSize: 3_000_000 }]])
    );
    expect(remapped["/shadow/A/B/01 T.mp3"].fileSize).toBe(3_000_000);
    expect(remapped["/shadow/A/B/01 T.mp3"].file_size).toBe(3_000_000);

    const result = compareLibraries(
      { "/shadow/A/B/01 T.mp3": "A/B/01 T.mp3" },
      { "/shadow/A/B/01 T.mp3": 3_000_000 },
      "/ipodrocks-web/1/Music",
      { "/ipodrocks-web/1/Music/A/B/01 T.mp3": { file_size: 3_000_000, mtime: Date.now() } },
      { libraryExpectedMtimes: { "/shadow/A/B/01 T.mp3": Date.now() - 7 * 86_400_000 } }
    );
    expect(result.tracksToSkip).toHaveLength(1);
  });

  it("falls back to 0 — judge by mtime — for a row from before the size column", () => {
    const remapped = remapTrackMapToShadow(
      { "/m/a.flac": { id: 1, path: "/m/a.flac", fileSize: 30_000_000 } },
      new Map([[1, { path: "/s/a.mp3", fileSize: null }]])
    );
    expect(remapped["/s/a.mp3"].fileSize).toBe(0);
  });
});
