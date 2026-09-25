import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// Separate from vite.config.ts so the production build config stays untouched; this only adds the
// test runner's own settings on top of it (same React plugin, so JSX compiles identically).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
    },
  })
);
