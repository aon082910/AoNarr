// axe-core runs + fingerprints. The fingerprint is { ruleId: failing node count } for one route in one project;
// the ratchet (lib/ratchet.ts) compares it with baselines/axe-baseline.json.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import type { Counters } from "./ratchet";

/** WCAG 2.0/2.1/2.2 level A + AA and axe's best practices. (axe 4.13 has no separate "wcag22a" tag.) */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/** Rules switched on explicitly because they are disabled by default. target-size = WCAG 2.2 SC 2.5.8 (24 px). */
export const AXE_EXTRA_RULES: Record<string, { enabled: boolean }> = {
  "target-size": { enabled: true },
};

export interface AxeNode {
  target: string;
  html: string;
  summary: string;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  nodeCount: number;
  nodes: AxeNode[];
}

export interface AxeRun {
  axeVersion: string;
  url: string;
  violations: AxeViolation[];
  /** Rules axe could not decide (needs review), by id + node count. */
  incomplete: Record<string, number>;
  passes: number;
  /** Every rule axe evaluated (violations, passes, incomplete, inapplicable): proves e.g. target-size really ran. */
  ruleIdsRun: string[];
  fingerprint: Counters;
  total: number;
}

/**
 * axe on a live page can jitter by a node or two between evaluations (observed: a table header on /audit-log mobile flagged in 1 of
 * 4 runs, with identical page and code). So a result that would FAIL the ratchet (or that is about to be recorded as a baseline) is
 * measured again: up to `extra` more passes, keeping the pass with the fewest violating nodes. A real regression reproduces in
 * every pass and still fails; a one-off jitter does not. `totals` lists every pass so nothing is hidden.
 */
export async function runAxeStable(page: Page, suspicious: (run: AxeRun) => boolean, extra: number): Promise<{ run: AxeRun; totals: number[] }> {
  let best = await runAxe(page);
  const totals = [best.total];
  for (let i = 0; i < extra && suspicious(best); i++) {
    await page.waitForTimeout(300);
    const again = await runAxe(page);
    totals.push(again.total);
    if (again.total < best.total) best = again;
  }
  return { run: best, totals };
}

export async function runAxe(page: Page): Promise<AxeRun> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).options({ rules: AXE_EXTRA_RULES }).analyze();
  const violations: AxeViolation[] = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    tags: v.tags,
    nodeCount: v.nodes.length,
    nodes: v.nodes.slice(0, 40).map((n) => ({
      target: Array.isArray(n.target) ? n.target.map(String).join(" >> ") : String(n.target),
      html: (n.html ?? "").slice(0, 220),
      summary: (n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 240),
    })),
  }));
  const fingerprint: Counters = {};
  for (const v of violations) fingerprint[v.id] = v.nodeCount;
  return {
    axeVersion: results.testEngine.version,
    url: results.url,
    violations,
    incomplete: Object.fromEntries(results.incomplete.map((i) => [i.id, i.nodes.length])),
    passes: results.passes.length,
    ruleIdsRun: [...new Set([...results.violations, ...results.passes, ...results.incomplete, ...results.inapplicable].map((r) => r.id))].sort(),
    fingerprint,
    total: violations.reduce((s, v) => s + v.nodeCount, 0),
  };
}
