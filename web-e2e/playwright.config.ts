// The sweep: 7 designs x 2 themes x 2 viewports = 28 projects named `${design}-${theme}-${viewport}`.
//   npx playwright test --project=classic-*          (Classic only: the blocking baseline)
//   npx playwright test                              (all 28)
// Design and theme are applied through localStorage (aonarr_design / aonarr_theme) via the per-project storage
// states written by tests/global-setup.ts; see README.md.
import { defineConfig } from "@playwright/test";
import { contextOptions, shared } from "./config/base";
import { DESIGNS, PATHS, THEMES, VIEWPORT_NAMES, projectName } from "./config/shared";

const workers = Number(process.env.E2E_WORKERS ?? 4);

export default defineConfig({
  ...shared,
  // Pure file / logic specs live in the other configs so they do not run 28 times.
  testIgnore: ["**/routes-drift.spec.ts", "**/judge-selftest.spec.ts"],
  workers,
  reporter: [
    ["list"],
    ["html", { outputFolder: `${PATHS.tmp}/report`, open: "never" }],
    ["json", { outputFile: `${PATHS.tmp}/results.json` }],
  ],
  snapshotDir: PATHS.screenBaselines,
  // baselines/screens/<platform>/<project>/<route>.png : the platform is part of the path on purpose.
  snapshotPathTemplate: "{snapshotDir}/{platform}/{projectName}/{arg}{ext}",
  projects: DESIGNS.flatMap((design) =>
    THEMES.flatMap((theme) =>
      VIEWPORT_NAMES.map((viewport) => ({
        name: projectName(design, theme, viewport),
        use: contextOptions(design, theme, viewport),
      })),
    ),
  ),
});
