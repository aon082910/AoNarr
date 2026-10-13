// Settings shared by playwright.config.ts (the 28-project sweep) and playwright.meta.config.ts (judge self-test).
import type { PlaywrightTestConfig } from "@playwright/test";
import {
  APP_ORIGIN, DEVICE_SCALE_FACTOR, HEADLESS, LOCALE, PATHS, TIMEZONE, VIEWPORTS, type Design, type Theme, type ViewportName,
} from "./shared";

/** Browser context options identical for every project (determinism). */
export function contextOptions(design: Design, theme: Theme, viewport: ViewportName) {
  const v = VIEWPORTS[viewport];
  return {
    baseURL: APP_ORIGIN,
    headless: HEADLESS,
    viewport: { width: v.width, height: v.height },
    isMobile: v.isMobile,
    hasTouch: v.hasTouch,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    locale: LOCALE,
    timezoneId: TIMEZONE,
    colorScheme: theme,
    reducedMotion: "reduce" as const,
    serviceWorkers: "block" as const,
    // Custom options read by tests/lib/fixtures.ts (they pick the storage state file and the expected <html> attributes).
    design,
    theme,
    viewportName: viewport,
    launchOptions: { args: ["--force-color-profile=srgb", "--disable-lcd-text"] },
    trace: "off" as const,
    screenshot: "off" as const,
    video: "off" as const,
  };
}

export const webServer: PlaywrightTestConfig["webServer"] = {
  // build-web.mjs rebuilds only when web/ sources changed; serve-web.mjs refuses to start unless the seeded
  // instance answers on 127.0.0.1:8989 and proves the /api proxy works before reporting ready.
  command: "node scripts/build-web.mjs && node scripts/serve-web.mjs",
  url: `${APP_ORIGIN}/api/health`,
  // Never reuse: a stale server would serve an old build and invalidate the baselines.
  reuseExistingServer: false,
  timeout: 180_000,
  stdout: "pipe",
  stderr: "pipe",
  gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
};

export const shared: Pick<
  PlaywrightTestConfig,
  "testDir" | "testMatch" | "fullyParallel" | "forbidOnly" | "retries" | "timeout" | "expect" | "outputDir" | "globalSetup" | "globalTeardown" | "updateSnapshots" | "webServer"
> = {
  testDir: "./tests",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: true,
  // E2E_RETRIES=n: re-run a failed test up to n times (reported as "flaky" when a retry passes, with the first error kept in results.json).
  retries: Number(process.env.E2E_RETRIES ?? 0),
  // 330 s: a hung navigation is retried up to 6 x 45 s inside openAndSettle (tests/lib/settle.ts) before the test gives up.
  timeout: 330_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      // Same machine + same renderer: anything beyond sub-pixel noise is a real change.
      maxDiffPixelRatio: 0.0005,
      threshold: 0.15,
    },
  },
  outputDir: `${PATHS.tmp}/test-results`,
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  // A plain run never writes baselines; use --update-snapshots (npm run update:baselines).
  updateSnapshots: "none",
  webServer,
};
