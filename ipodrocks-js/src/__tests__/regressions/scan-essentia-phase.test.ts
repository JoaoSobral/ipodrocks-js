/**
 * @vitest-environment node
 *
 * "Analyze with Essentia.js" runs during the library scan.
 *
 * The scan's file pass only reads key/BPM *tags* and skips every unchanged
 * file, so a track whose file has no key tag was analysed by nothing but the
 * Backfill button on the Savant tab. The setting's tooltip said the scan did
 * it and the Library banner said "re-scan", which could never help: a reporter
 * with 99 tagless .m4a files sat at 97% coverage through every rescan.
 *
 * Pinned with the real Essentia worker and a real (tagless) audio file:
 *  - off: the scan leaves it without a key;
 *  - switched on, a rescan of the *unchanged* file analyses it — the diff;
 *  - a further scan has nothing left to analyse.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installElectronMock, setupIpcSession } from "../harness/ipc-harness";
import type { IpcSession } from "../harness/ipc-harness";
import { canRunDbTests } from "../harness";

installElectronMock();

const FFMPEG = (() => {
  try {
    return (require("@ffmpeg-installer/ffmpeg") as { path: string }).path;
  } catch {
    return "ffmpeg";
  }
})();

describe.skipIf(!canRunDbTests)("Essentia key analysis as the scan's last phase", () => {
  let dir: string;
  let music: string;
  let session: IpcSession;

  const folders = () => [{ name: "Essentia Lib", path: music, contentType: "music" }];
  const camelot = async () => {
    const common = await import("../../main/ipc/common");
    return (
      common.getLibrary().getConnection().prepare("SELECT camelot FROM tracks").get() as {
        camelot: string | null;
      }
    ).camelot;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-scan-essentia-"));
    fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
    music = fs.mkdtempSync(path.join(os.homedir(), ".ipr-scan-essentia-lib-"));
    // An A-major-ish chord, 12 s, no tags at all.
    const made = spawnSync(FFMPEG, [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=554.37:duration=12",
      "-f", "lavfi", "-i", "sine=frequency=659.25:duration=12",
      "-filter_complex", "amix=inputs=3", "-map_metadata", "-1",
      path.join(music, "untagged.flac"),
    ]);
    expect(made.status).toBe(0);

    session = await setupIpcSession({ userDataDir: dir });
    // Under vitest the worker is TypeScript with no compiled script beside it;
    // bundle it the way tsc would ship it, on the module graph the handlers use.
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
    (await import("../../main/harmonic/essentia-analyzer")).setEssentiaWorkerScriptForTests(outfile);
    await session.invoke("library:addFolder", folders()[0]);
  }, 60_000);

  afterAll(() => {
    session?.cleanup();
    // On Windows the app database the IPC session opened stays locked until
    // the process exits, so the temp dir cannot always be removed here.
    for (const d of [dir, music]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("off: the scan reads tags only, so a tagless file gets no key", async () => {
    await session.invoke("settings:setHarmonicPrefs", { scanHarmonicData: true, analyzeWithEssentia: false });
    const res = await session.invoke<{ keysAnalyzed?: number }>("library:scan", { folders: folders() });
    expect(res.keysAnalyzed ?? 0).toBe(0);
    expect(await camelot()).toBeNull();
  }, 60_000);

  it("on: a rescan of the unchanged file analyses it", async () => {
    await session.invoke("settings:setHarmonicPrefs", {
      scanHarmonicData: true,
      analyzeWithEssentia: true,
      analyzePercent: 100,
    });
    const res = await session.invoke<{ keysAnalyzed?: number; filesProcessed: number }>("library:scan", {
      folders: folders(),
    });
    expect(res.keysAnalyzed).toBe(1);
    expect(await camelot()).toMatch(/^\d{1,2}[AB]$/);
  }, 120_000);

  it("then there is nothing left to analyse", async () => {
    const res = await session.invoke<{ keysAnalyzed?: number }>("library:scan", { folders: folders() });
    expect(res.keysAnalyzed ?? 0).toBe(0);
  }, 60_000);
});
