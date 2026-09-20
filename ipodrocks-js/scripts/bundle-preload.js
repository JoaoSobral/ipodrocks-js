/**
 * Bundles the preload script into a single self-contained file.
 *
 * `BrowserWindow` runs with `sandbox: true`, and a sandboxed preload's
 * `require` is a polyfill that resolves a short allowlist of Electron and Node
 * built-ins — **not** relative files. So the moment `preload.ts` imported
 * anything of ours (`src/shared/ipc-channels.ts`, so that the channel allowlist
 * has exactly one copy), the preload threw at load, `window.api` was never
 * exposed, and every renderer fell through to the web transport's bootstrap.
 * The visible symptom was "iPodRocks could not start — Failed to fetch" in the
 * desktop app, which names neither the preload nor the import.
 *
 * The output is `preload.bundle.js`, **not** `preload.js`. `tsc` emits its own
 * one-module-per-file `preload.js` from the same source, and having both tools
 * write the same path makes which one wins depend on their order — fatal under
 * `--watch`, where they interleave. A separate name means tsc keeps
 * typechecking the file (its emitted copy is simply unused) and this is the
 * only thing that writes what Electron loads.
 *
 * `electron` stays external: that one the sandbox polyfill does resolve.
 */
const path = require("path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [path.join(root, "src", "main", "preload.ts")],
  outfile: path.join(root, "dist", "main", "main", "preload.bundle.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "warning",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[bundle-preload] watching src/main/preload.ts");
    return;
  }
  await esbuild.build(options);
  console.log("[bundle-preload] dist/main/main/preload.bundle.js");
}

main().catch((err) => {
  console.error("[bundle-preload] failed:", err);
  process.exit(1);
});
