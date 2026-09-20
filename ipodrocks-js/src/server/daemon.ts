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

async function main(): Promise<void> {
  setHost(createNodeHost());
  registerIpcHandlers();

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
