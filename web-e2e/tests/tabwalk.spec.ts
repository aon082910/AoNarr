// Tab-walk on the ~12 representative routes: press Tab up to 120 times, record every focused element and flag
//   - focus indicator not visible (no outline, box-shadow or border change)
//   - focused element covered by a fixed/sticky widget (elementFromPoint at its centre is not the element)
//   - keyboard trap (focus stops advancing, or cycles inside a subset)
//   - tab stops vs visible interactive elements (unreachable controls, focusable non-interactive things)
//   - positive tabindex, and click-only elements (cursor:pointer without a focusable ancestor)
//   - mutations fired just by tabbing (e.g. a field that saves on blur): the GET-only guard still BLOCKS them, but here they
//     are counted (blockedMutations) and ratcheted instead of failing the test outright, because Classic is allowed known defects
// Counters are ratcheted against baselines/tabwalk-baseline.json (Classic blocking, redesigns report only).
import fs from "node:fs";
import path from "node:path";
import { PATHS, ratchetUpdateRequested } from "../config/shared";
import { test } from "./lib/fixtures";
import { compareToRatchet, ratchetIsBlocking, readRatchet, resultPath, type RatchetResultFile } from "./lib/ratchet";
import { openAndSettle } from "./lib/settle";
import { runTabwalk, tabwalkSummary } from "./lib/tabwalk";
import { loadSeedManifest, resolveRoutes, TABWALK_ROUTE_IDS } from "./routes";

const manifest = loadSeedManifest();
const baseline = readRatchet(PATHS.tabwalkBaseline, "tabwalk");
const only = (process.env.E2E_ROUTES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const routes = resolveRoutes(manifest).filter((r) => TABWALK_ROUTE_IDS.includes(r.id) && (only.length === 0 || only.includes(r.id) || only.includes("tabwalk")));

for (const route of routes) {
  test.describe(route.id, () => {
    test.use({ role: route.role, guardMode: "observe" });

    test("tabwalk", async ({ page, collector, guard, design, projectId }, testInfo) => {
      const reportOnly = route.ratchet === "report-only";
      await openAndSettle(page, route, collector, { expectText: route.expectText?.(manifest.params, manifest) });
      const guardBefore = guard.attempts.length;
      const walk = await runTabwalk(page, 120);
      // Blocked requests the route is KNOWN to make on its own (Activity retries its SSE stream ticket every 5 s+) do not count: how many
      // fire during the walk depends on how long the walk takes, which made this counter flip between 0 and 1 from run to run.
      const expected = route.expectedBlocked ?? [];
      const blocked = guard.attempts.slice(guardBefore).filter((x) => !expected.some((e) => e.method === x.method && e.pattern.test(x.path.split("?")[0])));
      walk.counters.blockedMutations = blocked.length;

      const result: RatchetResultFile & Record<string, unknown> = {
        project: projectId, route: route.id, counters: walk.counters, reportOnly, summary: tabwalkSummary(walk),
        trap: walk.trap, unreachable: walk.unreachable, clickOnly: walk.clickOnly, blockedMutations: blocked,
        stops: walk.stops.map((s) => ({ i: s.index, role: s.role, name: s.name, selector: s.selector, indicator: s.indicator?.kinds ?? null, strong: s.indicator?.strong ?? null, obscured: s.obscured })),
      };
      const file = resultPath(PATHS.tabwalk, projectId, route.id);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      await testInfo.attach("tabwalk.json", { path: file, contentType: "application/json" });

      const c = walk.counters;
      testInfo.annotations.push({
        type: "tabwalk",
        description: `${walk.stops.length} stops / ${walk.visibleInteractive} visible interactive, ${walk.cycleCompleted ? "cycle completed" : walk.trap.detected ? "TRAP" : "cap reached"}; noIndicator ${c.noIndicator}, obscuredByFixed ${c.obscuredByFixed}, covered ${c.coveredOrClipped}, unreachable ${c.unreachable}, clickOnly ${c.clickOnly}, blockedMutations ${c.blockedMutations}`,
      });

      if (ratchetUpdateRequested()) return;
      const cmp = compareToRatchet(baseline, projectId, route.id, walk.counters);
      testInfo.annotations.push({ type: "tabwalk-ratchet", description: `${cmp.status}${cmp.comparedAgainst ? ` vs ${cmp.comparedAgainst}` : ""}` });
      if (!ratchetIsBlocking(design) || reportOnly) return;
      if (cmp.status === "no-baseline") {
        throw new Error(`No tab-walk baseline for ${projectId} / ${route.id}. Establish one with: npm run update:baselines (owner approves the diff).`);
      }
      if (cmp.status === "worse") {
        throw new Error(`Tab-walk got worse for ${projectId} / ${route.id}: ` + cmp.worse.map((d) => `${d.key} ${d.baseline} -> ${d.current}`).join(", "));
      }
    });
  });
}
