// Smoke sweep: per route, per project. Fails on console errors, uncaught exceptions, failed or 4xx/5xx requests,
// requests that leave 127.0.0.1, horizontal overflow, a design/theme that did not apply, an unexpected redirect,
// or any attempted non-GET /api call (the GET-only guard fixture). Saves a text inventory per route as an artifact.
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../config/shared";
import { judge, type Finding } from "./lib/allowlist";
import { collectInventory, hasOverflow, measureOverflow } from "./lib/checks";
import { test } from "./lib/fixtures";
import { SettleError, openAndSettle, type SettleReport } from "./lib/settle";
import { loadSeedManifest, selectedRoutes } from "./routes";

const manifest = loadSeedManifest();

function writeJson(dir: string, project: string, route: string, data: unknown): string {
  const file = path.join(dir, project, `${route}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

for (const route of selectedRoutes(manifest)) {
  test.describe(route.id, () => {
    test.use({ role: route.role, allowBlocked: route.expectedBlocked ?? [] });

    test("smoke", async ({ page, collector, guard, design, theme, projectId }, testInfo) => {
      const problems: string[] = [];
      let settleReport: SettleReport | undefined;
      try {
        settleReport = await openAndSettle(page, route, collector, { expectText: route.expectText?.(manifest.params, manifest) });
      } catch (e) {
        if (e instanceof SettleError) {
          settleReport = e.report;
          problems.push(`settle: ${e.message}`);
        } else {
          throw e;
        }
      }

      // Measurements run even when settling failed, so the artifact explains what the page looked like.
      const overflow = await measureOverflow(page).catch(() => null);
      const inventory = await collectInventory(page).catch(() => null);
      const clipped = await page.evaluate(() => (window as any).__e2e.clippedText(8)).catch(() => null); // report-only heuristic

      const findings: Finding[] = collector.findings();
      if (overflow && hasOverflow(overflow)) {
        findings.push({
          kind: "overflow",
          text: `scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth} (+${overflow.overflowPx}px); widest: ${overflow.offenders[0]?.selector ?? "?"}`,
        });
      }
      const judged = judge(findings, route, projectId);

      if (inventory) {
        const wantDesign = design === "classic" ? null : design;
        const wantTheme = theme === "light" ? "light" : null;
        if (inventory.attrs.design !== wantDesign) problems.push(`html[data-design] is ${inventory.attrs.design}, expected ${wantDesign}`);
        if (inventory.attrs.theme !== wantTheme) problems.push(`html[data-theme] is ${inventory.attrs.theme}, expected ${wantTheme}`);
      }
      if (settleReport && !route.redirectsTo && settleReport.finalUrl !== route.href) {
        problems.push(`redirected: asked for ${route.href}, ended on ${settleReport.finalUrl}`);
      }

      const record = {
        route: route.id, project: projectId, href: route.href, role: route.role,
        settle: settleReport, overflow, clipped, apiCalls: collector.apiCallSummary(), warnings: collector.warnings,
        guard: { getsPassed: guard.passed, blockedMutations: guard.attempts },
        violations: judged.violations, allowed: judged.allowed,
      };
      const file = writeJson(PATHS.smoke, projectId, route.id, record);
      if (inventory) writeJson(PATHS.inventory, projectId, route.id, inventory);
      await testInfo.attach("smoke.json", { path: file, contentType: "application/json" });
      if (inventory) await testInfo.attach("text-inventory.json", { body: JSON.stringify(inventory, null, 2), contentType: "application/json" });
      if (settleReport && settleReport.navRetries > 0) testInfo.annotations.push({ type: "navigation-retry", description: `page.goto was retried ${settleReport.navRetries}x (hung or reset navigation, see tests/lib/settle.ts)` });
      for (const a of judged.allowed) {
        testInfo.annotations.push({ type: `allowed ${a.finding.kind}${a.verified ? "" : " (unverified)"}`, description: `${a.finding.text} -- ${a.reason}` });
      }

      for (const v of judged.violations) problems.push(`${v.kind}: ${v.text}`);
      if (problems.length) throw new Error(`${route.id} [${projectId}] ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
    });
  });
}
