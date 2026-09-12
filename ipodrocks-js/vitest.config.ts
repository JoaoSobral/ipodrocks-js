import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@main": path.resolve(__dirname, "src/main"),
      "@shared": path.resolve(__dirname, "src/shared"),
      "@assets": path.resolve(__dirname, "assets"),
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
    /**
     * Vitest's default is 5s, which is too tight for the slowest runner we
     * build on. Each test file gets its own worker, so the first test in a file
     * pays the cold cost of loading better-sqlite3's native binding and running
     * the whole of SCHEMA_SQL plus every migration — about 200ms on a dev Mac
     * and over 6s on the Windows CI runner, which failed the release build for
     * v2.3.3-alpha. It is the first test in the file that times out, whichever
     * one that happens to be, so a per-test timeout would just move the problem.
     * 20s still catches a genuine hang; it only stops a slow machine being
     * reported as a broken one.
     */
    testTimeout: 20_000,
    environment: "node",
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
