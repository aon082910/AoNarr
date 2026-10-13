// axe-core per route (WCAG 2.0/2.1/2.2 A + AA tags + best-practice, target-size enabled), saved as a
// fingerprint { ruleId: failing node count } and compared with baselines/axe-baseline.json (ratchet: never worse).
//   Classic projects: blocking.  Other designs: report only, compared with Classic of the same theme+viewport
//   (E2E_STRICT_RATCHETS=1 makes them blocking).  E2E_UPDATE_RATCHETS=1: record instead of compare (see README).
import fs from "node:fs";
import path from "node:path";
import { PATHS, ratchetUpdateRequested } from "../config/shared";
import { runAxeStable } from "./lib/axe";
import { test } from "./lib/fixtures";
import { compareToRatchet, ratchetIsBlocking, readRatchet, resultPath, type RatchetResultFile } from "./lib/ratchet";
import { openAndSettle } from "./lib/settle";
import { loadSeedManifest, selectedRoutes } from "./routes";

const manifest = loadSeedManifest();
const baseline = readRatchet(PATHS.axeBaseline, "axe");

for (const route of selectedRoutes(manifest)) {
  test.describe(route.id, () => {
    test.use({ role: route.role, allowBlocked: route.expectedBlocked ?? [] });

    test("axe", async ({ page, collector, design, projectId }, testInfo) => {
      const reportOnly = route.ratchet === "report-only";
      await openAndSettle(page, route, collector, { expectText: route.expectText?.(manifest.params, manifest) });
      // Measured again when it would fail the ratchet or is being recorded as the baseline (see runAxeStable).
      const { run, totals } = await runAxeStable(
        page,
        (r) => ratchetUpdateRequested() || (ratchetIsBlocking(design) && !reportOnly && compareToRatchet(baseline, projectId, route.id, r.fingerprint).status === "worse"),
        ratchetUpdateRequested() ? 1 : 2,
      );

      const result: RatchetResultFile & Record<string, unknown> = {
        project: projectId, route: route.id, counters: run.fingerprint, reportOnly,
        axeVersion: run.axeVersion, totalNodes: run.total, passTotals: totals, incomplete: run.incomplete, passes: run.passes, violations: run.violations,
      };
      const file = resultPath(PATHS.axe, projectId, route.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      await testInfo.attach("axe.json", { path: file, contentType: "application/json" });

      if (ratchetUpdateRequested()) {
        testInfo.annotations.push({ type: "axe-ratchet", description: `recorded for baseline update: ${JSON.stringify(run.fingerprint)}` });
        return;
      }
      const cmp = compareToRatchet(baseline, projectId, route.id, run.fingerprint);
      testInfo.annotations.push({ type: "axe-ratchet", description: `${cmp.status}${cmp.comparedAgainst ? ` vs ${cmp.comparedAgainst}` : ""}; ${run.total} node(s): ${JSON.stringify(run.fingerprint)}${totals.length > 1 ? ` (passes: ${totals.join(", ")})` : ""}` });
      if (!ratchetIsBlocking(design) || reportOnly) return;
      if (cmp.status === "no-baseline") {
        throw new Error(`No axe baseline for ${projectId} / ${route.id}. Establish one with: npm run update:baselines (owner approves the diff).`);
      }
      if (cmp.status === "worse") {
        throw new Error(`axe got worse for ${projectId} / ${route.id} (vs ${cmp.comparedAgainst}): ` + cmp.worse.map((d) => `${d.key} ${d.baseline} -> ${d.current}`).join(", "));
      }
    });
  });
}
