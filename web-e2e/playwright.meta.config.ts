// Judge self-test: proves the sweep's helpers can FAIL. One Classic dark desktop project (+ pure logic tests).
//   npm run test:selftest
import { defineConfig } from "@playwright/test";
import { contextOptions, shared } from "./config/base";
import { PATHS } from "./config/shared";

export default defineConfig({
  ...shared,
  testMatch: /judge-selftest\.spec\.ts$/,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: `${PATHS.tmp}/results-selftest.json` }]],
  // Goldens of the screenshot self-test live outside baselines/ so they can never be mistaken for real baselines.
  snapshotDir: `${PATHS.tmp}/selftest-snapshots`,
  snapshotPathTemplate: "{snapshotDir}/{platform}/{projectName}/{arg}{ext}",
  projects: [{ name: "selftest", use: contextOptions("classic", "dark", "desktop") }],
});
