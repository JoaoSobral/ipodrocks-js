/**
 * @vitest-environment node
 *
 * Regression — ffmpeg and ffprobe follow references out of an untrusted file.
 *
 * ffmpeg picks its demuxer by probing content, not by extension, and its `hls`
 * demuxer opens every segment line of an `#EXTM3U` playlist. So a `.mp3` whose
 * bytes are a playlist naming `/some/other/file.mp3` — a podcast enclosure is
 * stored under whatever extension the feed's URL carried — made every ffmpeg
 * call in the app read *that* file instead: its cover art (embedded-art), its
 * whole audio (`player:prepare` with `forceTranscode`), its tags (the
 * ReplayGain probe), its samples (the Essentia decode).
 *
 * Every call now goes through `ffmpegInputArgs()` (utils/ffmpeg-input.ts).
 * Each case below has a control on the real file, so a pass means "the
 * restriction refused the playlist" and never "the fixture was broken". The
 * first test proves the playlist really is live against unrestricted ffmpeg.
 *
 * Real ffmpeg throughout — the bundled `@ffmpeg-installer` binary, which is
 * the one the app ships and so the one whose demuxer list matters.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const FFMPEG: string = require("@ffmpeg-installer/ffmpeg").path;

vi.mock("../../main/utils/ffmpeg-path", () => ({
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  getFfmpegPath: () => require("@ffmpeg-installer/ffmpeg").path,
}));

// Every embedded-art read below must reach the ffmpeg fallback, which only
// runs when music-metadata throws. The ReplayGain probe is exported separately
// and never touches the parser.
vi.mock("music-metadata", () => ({
  parseFile: () => Promise.reject(new Error("forced parse failure")),
  parseBuffer: () => Promise.reject(new Error("forced parse failure")),
}));

import { ffmpegInputArgs } from "../../main/utils/ffmpeg-input";
import { extractEmbeddedPicture } from "../../main/utils/embedded-art";
import {
  prepareTrack,
  cancelPrepare,
  getPlayerTempDir,
} from "../../main/player/player-source";
import { convertWithCodec, readReplayGainFromFile } from "../../main/sync/sync-conversion";
import { buildCoverFfmpegArgs } from "../../main/sync/rockbox-cover";
import {
  analyzeAudioWithEssentia,
  setEssentiaWorkerScriptForTests,
} from "../../main/harmonic/essentia-analyzer";

const RG = {
  REPLAYGAIN_TRACK_GAIN: "-3.38 dB",
  REPLAYGAIN_TRACK_PEAK: "0.998054",
};

let dir: string;
let secretMp3: string;
let secretFlac: string;
let secretJpg: string;
/** HLS playlist pointing at `secretMp3`, named like a track. */
let evilMp3: string;
/** Same playlist pointing at `secretFlac`. */
let evilFlac: string;
/** Same playlist pointing at `secretJpg`, named like a cover. */
let evilJpg: string;

function ff(args: string[]): void {
  const r = spawnSync(FFMPEG, ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture ffmpeg failed: ${r.stderr}`);
}

function playlistFor(target: string): string {
  return (
    "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n" +
    `#EXTINF:10,\n${target}\n#EXT-X-ENDLIST\n`
  );
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-ffmpeg-untrusted-"));
  secretMp3 = path.join(dir, "secret", "private.mp3");
  secretFlac = path.join(dir, "secret", "private.flac");
  secretJpg = path.join(dir, "secret", "private.jpg");
  fs.mkdirSync(path.dirname(secretMp3), { recursive: true });

  // An MP3 carrying an attached picture, so there is art to steal.
  ff([
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-f", "lavfi", "-i", "color=red:s=64x64:d=1",
    "-map", "0:a", "-map", "1:v", "-frames:v", "1",
    "-c:a", "libmp3lame", "-c:v", "mjpeg", "-id3v2_version", "3",
    "-disposition:v", "attached_pic",
    secretMp3,
  ]);
  const flacArgs = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "flac"];
  for (const [k, v] of Object.entries(RG)) flacArgs.push("-metadata", `${k}=${v}`);
  ff([...flacArgs, secretFlac]);
  ff(["-f", "lavfi", "-i", "color=blue:s=64x64:d=1", "-frames:v", "1", secretJpg]);

  evilMp3 = path.join(dir, "podcasts", "episode.mp3");
  evilFlac = path.join(dir, "podcasts", "episode.flac");
  evilJpg = path.join(dir, "podcasts", "cover.jpg");
  fs.mkdirSync(path.dirname(evilMp3), { recursive: true });
  fs.writeFileSync(evilMp3, playlistFor(secretMp3));
  fs.writeFileSync(evilFlac, playlistFor(secretFlac));
  fs.writeFileSync(evilJpg, playlistFor(secretJpg));
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the fixture", () => {
  it("is live: unrestricted ffmpeg transcodes the file the playlist names", () => {
    const out = path.join(dir, "control.ogg");
    const r = spawnSync(FFMPEG, [
      "-v", "error", "-y", "-i", evilMp3, "-c:a", "libvorbis", "-map", "0:a", "-vn", out,
    ]);
    expect(r.status).toBe(0);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
  });
});

describe("ffmpegInputArgs", () => {
  it("names the file with a protocol and demuxer whitelist, never a bare -i", () => {
    const args = ffmpegInputArgs("relative/x.mp3");
    expect(args.slice(0, 2)).toEqual(["-protocol_whitelist", "file"]);
    expect(args[2]).toBe("-format_whitelist");
    for (const banned of ["hls", "concat", "dash", "image2", "tee", "applehttp"]) {
      expect(args[3].split(",")).not.toContain(banned);
    }
    expect(args[4]).toBe("-i");
    // Resolved, so a path can never be read as `http:` / `concat:` / `pipe:`.
    expect(path.isAbsolute(args[5])).toBe(true);
    expect(ffmpegInputArgs("http://example.com/a.mp3")[5].startsWith("http:")).toBe(false);
  });

  it("refuses a playlist posing as a track, and still opens the real one", () => {
    const run = (p: string) =>
      spawnSync(FFMPEG, ["-v", "error", ...ffmpegInputArgs(p), "-f", "null", "-"], {
        encoding: "utf8",
      });
    const evil = run(evilMp3);
    expect(evil.status).not.toBe(0);
    expect(evil.stderr).toMatch(/not on whitelist/i);
    expect(run(secretMp3).status).toBe(0);
    expect(run(secretFlac).status).toBe(0);
  });
});

describe("embedded art (podcast cover sidecar, Rockbox artwork)", () => {
  it("reads no picture through a playlist", async () => {
    expect(await extractEmbeddedPicture(evilMp3)).toBeNull();
  });

  it("control: the ffmpeg fallback still reads the real file's picture", async () => {
    const pic = await extractEmbeddedPicture(secretMp3);
    expect(pic?.format).toBe("image/jpeg");
  });
});

describe("player:prepare transcode", () => {
  afterEach(async () => {
    await cancelPrepare("ffmpeg-untrusted");
  });

  it("forceTranscode on a playlist fails and leaves no temp file behind", async () => {
    const before = fs.existsSync(getPlayerTempDir()) ? fs.readdirSync(getPlayerTempDir()) : [];
    await expect(
      prepareTrack({ path: evilMp3, codec: "MP3" }, true, "ffmpeg-untrusted")
    ).rejects.toThrow(/ffmpeg/);
    const after = fs.readdirSync(getPlayerTempDir());
    expect(after.filter((f) => !before.includes(f))).toEqual([]);
  });

  it("control: forceTranscode on a real track still produces audio", async () => {
    const { strategy } = await prepareTrack(
      { path: secretMp3, codec: "MP3" },
      true,
      "ffmpeg-untrusted"
    );
    expect(strategy).toBe("transcode");
  });
});

describe("sync transcode and ReplayGain probe", () => {
  it("a device transcode of a playlist fails instead of copying the target's audio", async () => {
    const dest = path.join(dir, "device", "episode.ogg");
    expect(await convertWithCodec(evilFlac, dest, { codec: "ogg", bitrate: 128 })).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("control: the same transcode of the real file succeeds", async () => {
    const dest = path.join(dir, "device", "private.ogg");
    expect(await convertWithCodec(secretFlac, dest, { codec: "ogg", bitrate: 128 })).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  it("reads no ReplayGain through a playlist", () => {
    expect(readReplayGainFromFile(evilFlac)).toBeUndefined();
  });

  it("control: reads the real file's ReplayGain", () => {
    expect(readReplayGainFromFile(secretFlac)).toEqual(RG);
  });
});

describe("Rockbox cover generation", () => {
  const run = (src: string) => {
    const [bin, ...args] = buildCoverFfmpegArgs(src, path.join(dir, `out-${path.basename(src)}.jpg`), 300);
    return spawnSync(bin, ["-v", "error", ...args], { encoding: "utf8" });
  };

  it("refuses a 'cover.jpg' that is a playlist naming another image", () => {
    expect(run(evilJpg).status).not.toBe(0);
  });

  it("control: a real JPEG, and an embedded-art scratch file with no image extension", () => {
    expect(run(secretJpg).status).toBe(0);
    const scratch = path.join(dir, "cover.jpg.src");
    fs.copyFileSync(secretJpg, scratch);
    expect(run(scratch).status).toBe(0);
  });
});

describe("Essentia decode", () => {
  beforeAll(async () => {
    // Under vitest this module is TypeScript source with no compiled worker
    // beside it; bundle the real one, exactly as tsc would ship it.
    const esbuild = await import("esbuild");
    const outfile = path.join(dir, "essentia-worker.js");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../../main/harmonic/essentia-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      logLevel: "silent",
    });
    setEssentiaWorkerScriptForTests(outfile);
  });

  afterAll(() => setEssentiaWorkerScriptForTests(null));

  it("analyses nothing through a playlist", async () => {
    expect(await analyzeAudioWithEssentia(evilMp3)).toBeNull();
  });

  it("control: the real file is decoded and analysed on the worker", async () => {
    const features = await analyzeAudioWithEssentia(secretMp3);
    expect(features).not.toBeNull();
    expect(features?.key ?? features?.bpm).not.toBeNull();
  }, 60_000);
});
