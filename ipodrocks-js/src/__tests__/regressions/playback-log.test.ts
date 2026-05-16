/**
 * @vitest-environment node
 *
 * Regression coverage for the Rockbox playback log parser — handling malformed
 * lines, comments, zero-duration entries, and Windows-style line endings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import { createTmpDir, cleanupTmp } from "../harness";

import {
  parseRockboxPlaybackLog,
  parseRockboxPlaybackLogSafe,
} from "../../main/playlists/rockbox-log-parser";

describe("rockbox playback log parser — regressions", () => {
  let mount: string;

  beforeEach(() => {
    mount = createTmpDir("rockbox-log-");
    fs.mkdirSync(path.join(mount, ".rockbox"), { recursive: true });
  });

  afterEach(() => {
    cleanupTmp(mount);
  });

  function writeLog(contents: string) {
    fs.writeFileSync(path.join(mount, ".rockbox", "playback.log"), contents);
  }

  it("parses well-formed lines and computes completionRatio", () => {
    writeLog(
      [
        "# header",
        "1700000000:60000:120000:/music/a.mp3",
        "1700000060:30000:30000:/music/b.mp3",
      ].join("\n")
    );

    const events = parseRockboxPlaybackLog(mount);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      timestamp: 1700000000,
      elapsedMs: 60000,
      totalMs: 120000,
      filePath: "/music/a.mp3",
      completionRatio: 0.5,
    });
    expect(events[1].completionRatio).toBe(1);
  });

  it("skips comment lines, blank lines, and non-numeric lines", () => {
    writeLog(
      [
        "# comment",
        "",
        "garbage_line",
        "1700000000:60000:120000:/good.mp3",
        "1700000001:foo:120000:/bad-elapsed.mp3", // NaN elapsed
        "1700000002:30000:bar:/bad-total.mp3", // NaN total
        "no_colons_here_at_all",
      ].join("\n")
    );

    const events = parseRockboxPlaybackLog(mount);
    expect(events.map((e) => e.filePath)).toEqual(["/good.mp3"]);
  });

  it("treats totalMs = 0 as completionRatio = 0 (no NaN leak)", () => {
    writeLog("1700000000:5000:0:/zero-total.mp3");
    const events = parseRockboxPlaybackLog(mount);
    expect(events).toHaveLength(1);
    expect(events[0].completionRatio).toBe(0);
  });

  it("handles CRLF line endings", () => {
    writeLog("1700000000:60000:120000:/a.mp3\r\n1700000060:30000:30000:/b.mp3\r\n");
    const events = parseRockboxPlaybackLog(mount);
    expect(events).toHaveLength(2);
    expect(events[1].filePath).toBe("/b.mp3");
  });

  it("preserves colons inside the file path (no greedy split)", () => {
    writeLog("1700000000:60000:120000:/Volume:1/music/a:b.mp3");
    const events = parseRockboxPlaybackLog(mount);
    expect(events).toHaveLength(1);
    expect(events[0].filePath).toBe("/Volume:1/music/a:b.mp3");
  });

  it("safe variant returns [] for missing file instead of throwing", () => {
    cleanupTmp(mount);
    mount = createTmpDir("rockbox-log-empty-");
    expect(parseRockboxPlaybackLogSafe(mount)).toEqual([]);
    expect(() => parseRockboxPlaybackLog(mount)).toThrow();
  });
});
