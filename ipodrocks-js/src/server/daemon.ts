/**
 * The headless entry point: `npm run server`.
 *
 * Deliberately tiny, and deliberately not importing anything from
 * `src/main/index.ts`. The whole value of the host adapter is that this process
 * can register the Node host and run the same handlers with no Electron in
 * `node_modules` at all — which is what Phase 5's container needs.
 */
import { setHost, createNodeHost } from "../main/host";
import { registerIpcHandlers } from "../main/ipc";
import { ensureServerStarted, stopServerIfRunning } from "./index";
import { getFfmpegPath } from "../main/utils/ffmpeg-path";
import { isMpcencAvailable } from "../main/utils/mpcenc";

/**
 * Says which encoders this process actually found.
 *
 * ffmpeg is a dependency and is essentially always there; `mpcenc` is bundled
 * by nothing and has to come from the image or the host. Without it every
 * Musepack shadow profile fails at the first track, and in a container that
 * reads as a broken app rather than a missing package. The UI already answers
 * this per request through `app:isMpcencAvailable`; this line is for whoever is
 * reading `docker logs`.
 */
function reportEncoders(): void {
  let ffmpeg = "not found";
  try {
    ffmpeg = getFfmpegPath();
  } catch (err) {
    ffmpeg = `not found (${err instanceof Error ? err.message : String(err)})`;
  }
  console.log(`[server] ffmpeg: ${ffmpeg}`);
  console.log(
    isMpcencAvailable()
      ? "[server] mpcenc: found"
      : "[server] mpcenc: not found — Musepack shadow-library profiles are " +
          "unavailable. Install it (Debian/Ubuntu: musepack-tools) and restart."
  );
}

async function main(): Promise<void> {
  setHost(createNodeHost());
  registerIpcHandlers();
  reportEncoders();

  const status = await ensureServerStarted();
  if (!status.running) {
    console.error(`[server] could not start: ${status.lastError ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }

  const shutdown = (signal: string) => {
    void (async () => {
      console.log(`[server] ${signal} — shutting down`);
      await stopServerIfRunning();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exitCode = 1;
});
