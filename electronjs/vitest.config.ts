import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@main": path.resolve(__dirname, "src/main"),
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
