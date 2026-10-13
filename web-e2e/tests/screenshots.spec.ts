// Screenshots. Classic projects: blocking toHaveScreenshot against baselines/screens/<platform>/<project>/<route>.png
// (full page). Every other design only captures into .tmp/captures/<project>/ (non-blocking, for review).
// Routes marked pixel:"capture-only" in routes.ts (live host values, not masked yet) are captured for Classic too.
// A page that does not settle fails here too (a picture of a half-loaded page would be a meaningless baseline);
// smoke.spec.ts reports the details.
import { test } from "./lib/fixtures";
import { openAndSettle } from "./lib/settle";
import { capture, expectMatchesBaseline } from "./lib/screens";
import { loadSeedManifest, selectedRoutes } from "./routes";

const manifest = loadSeedManifest();

for (const route of selectedRoutes(manifest)) {
  test.describe(route.id, () => {
    test.use({ role: route.role, allowBlocked: route.expectedBlocked ?? [] });

    test("screenshot", async ({ page, collector, design, projectId }, testInfo) => {
      await openAndSettle(page, route, collector, { expectText: route.expectText?.(manifest.params, manifest) });

      const blocking = design === "classic" && route.pixel !== "capture-only";
      if (blocking) {
        await expectMatchesBaseline(page, route);
      } else {
        const file = await capture(page, route, projectId);
        testInfo.annotations.push({
          type: "capture",
          description: `${file}${design === "classic" ? ` (Classic capture-only: ${route.volatile ?? "volatile"})` : " (non-blocking, redesign)"}`,
        });
      }
    });
  });
}
