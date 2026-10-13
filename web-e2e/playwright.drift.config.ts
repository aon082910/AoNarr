// Route drift only: reads web/src/App.tsx + main.tsx and tests/routes.ts. No browser, no web server, no seeded
// instance, so it is cheap enough to run first in every other script.   npm run test:drift
import { defineConfig } from "@playwright/test";
import { PATHS } from "./config/shared";

export default defineConfig({
  testDir: "./tests",
  testMatch: /routes-drift\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [["list"]],
  outputDir: `${PATHS.tmp}/test-results-drift`,
});
