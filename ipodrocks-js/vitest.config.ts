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
    environment: "node",
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
