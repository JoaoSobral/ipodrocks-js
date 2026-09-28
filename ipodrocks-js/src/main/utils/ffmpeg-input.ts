/**
 * The one way to name an input file to ffmpeg or ffprobe.
 *
 * **Every file this app hands to ffmpeg is untrusted.** A library folder holds
 * whatever was downloaded into it, and a podcast enclosure is stored under
 * whatever extension the feed's URL carried. ffmpeg does not choose a demuxer
 * by extension — it probes the *content* — and several of its demuxers follow
 * references to further files: `hls` opens every segment line of an `#EXTM3U`
 * playlist, `concat` every `file` line, `image2` a whole glob or sequence. A
 * `.mp3` whose bytes are a playlist naming `/srv/private/album/01.mp3` made
 * every ffmpeg call in the app read that file instead: its cover art copied
 * onto a guest's device, its audio transcoded by `player:prepare` and served
 * back, its duration written into the guest-visible track row.
 *
 * Two AVFormatContext options, passed as *input* options, close it:
 *
 * - `-format_whitelist` — the demuxer ffmpeg probes its way to must be on the
 *   list or the open fails ("Format not on whitelist"). The list is every
 *   *self-contained* audio container the library can hold; none of the
 *   reference-following demuxers is on it. Probing still picks the demuxer, so
 *   a file with the "wrong" extension that really is FLAC still opens.
 * - `-protocol_whitelist file` — the input can only be a local file, never
 *   `http:`, `tcp:`, `concat:`, `data:` or `pipe:`. The path is also resolved
 *   to an absolute one first, so it always starts with `/` (or a drive letter)
 *   and can never be read as a protocol prefix in the first place.
 *
 * **Do not add a demuxer to these lists that can open another file.** Check
 * `ffmpeg -h demuxer=<name>` and the demuxer's source before adding one; the
 * extension-looking names (`mov,mp4,m4a,…`) are single demuxers, matched by any
 * of their aliases. `mov`'s external data references are off by default
 * (`enable_drefs`), which is what keeps it on the list.
 */
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

/** Self-contained audio containers — every format a library track can be. */
export const AUDIO_INPUT_DEMUXERS: readonly string[] = [
  "mp3", "flac", "ogg", "mov", "mp4", "m4a", "wav", "w64", "aiff", "caf",
  "ape", "mpc", "mpc8", "wv", "tta", "tak", "shn", "asf", "matroska", "webm",
  "aac", "ac3", "eac3", "dts", "truehd", "mlp", "loas", "amr", "au",
  "dsf", "iff",
];

/**
 * Single still images. Deliberately the `*_pipe` demuxers and **not** `image2`,
 * whose default pattern handling expands a filename into a glob or a numbered
 * sequence and so reads files other than the one named. Probing a real JPEG or
 * PNG picks the pipe demuxer on its own (it outscores `image2`'s extension
 * match), so nothing needs forcing.
 */
export const IMAGE_INPUT_DEMUXERS: readonly string[] = [
  "jpeg_pipe", "png_pipe", "bmp_pipe", "gif", "gif_pipe", "webp_pipe", "tiff_pipe",
];

export type FfmpegInputKind = "audio" | "image";

/**
 * `[...restrictions, "-i", absolutePath]` — splice it into an argv wherever a
 * bare `-i <path>` used to be. Works for `ffprobe` too, which takes the same
 * input options.
 */
export function ffmpegInputArgs(
  filePath: string,
  kind: FfmpegInputKind = "audio"
): string[] {
  const list = kind === "image" ? IMAGE_INPUT_DEMUXERS : AUDIO_INPUT_DEMUXERS;
  return [
    "-protocol_whitelist", "file",
    "-format_whitelist", list.join(","),
    "-i", path.resolve(filePath),
  ];
}

/**
 * For a child whose output nobody reads: never wait on stdin, never print
 * progress, and only say something when it fails. Pair with `stdio: "ignore"`
 * (or a drained pipe) — an unread pipe that fills blocks ffmpeg in `write(2)`
 * forever, which is how `player:prepare` and the Essentia decode used to hang.
 */
export const FFMPEG_QUIET_ARGS: readonly string[] = [
  "-nostdin", "-nostats", "-hide_banner", "-loglevel", "error",
];

export type QuietFfmpegOutcome =
  | { kind: "exited"; code: number; stderrTail: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "spawn-error"; error: Error };

/** Kept for the error message; ffmpeg at `-loglevel error` says little. */
const STDERR_TAIL_BYTES = 2048;

/**
 * Run ffmpeg to completion with nothing able to wedge it: stdin and stdout are
 * ignored, stderr is drained continuously (only its tail is kept), and a hard
 * wall-clock limit SIGKILLs the child. An abort kills it too. Never rejects —
 * the caller decides what each outcome means, and always gets one.
 */
export function runQuietFfmpeg(
  ffmpegPath: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; onSpawn?: (proc: ChildProcess) => void }
): Promise<QuietFfmpegOutcome> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, [...FFMPEG_QUIET_ARGS, ...args], {
        stdio: ["ignore", "ignore", "pipe"],
        env: opts.env ?? process.env,
      });
    } catch (err) {
      resolve({ kind: "spawn-error", error: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    opts.onSpawn?.(proc);

    let settled = false;
    let tail = "";
    const finish = (outcome: QuietFfmpegOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const kill = (): void => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const onAbort = (): void => {
      kill();
      finish({ kind: "aborted" });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      kill();
      finish({ kind: "timeout" });
    }, opts.timeoutMs);

    proc.stderr?.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    proc.on("error", (error) => finish({ kind: "spawn-error", error }));
    proc.on("close", (code) => finish({ kind: "exited", code: code ?? 1, stderrTail: tail.trim() }));
  });
}
