// Custom keyboard walk: axe has no rule for focus-visible, focus-not-obscured or keyboard traps, so this presses
// Tab up to N times and records every focused element. The in-page measurements live in browser-helpers.js.
import type { Page } from "@playwright/test";
import type { Counters } from "./ratchet";

export interface TabStop {
  index: number;
  uid: number;
  tag: string;
  role: string;
  name: string;
  selector: string;
  rect: { x: number; y: number; w: number; h: number };
  visible: boolean;
  interactive: boolean;
  positiveTabindex: boolean;
  obscured: null | { kind: string; by?: string; fixedBy?: string | null };
  /** Filled in when focus moves on (or at the end of the walk). */
  indicator?: { strong: boolean; weakOnly: boolean; kinds: string[]; removed?: boolean };
}

export interface TabwalkResult {
  maxStops: number;
  presses: number;
  stops: TabStop[];
  cycleCompleted: boolean;
  reachedCap: boolean;
  trap: { detected: boolean; reason: string | null; at: number | null };
  visibleInteractive: number;
  unreachable: { selector: string; name: string }[] | null;
  clickOnly: { count: number; samples: { selector: string; text: string }[] };
  positiveTabindex: number;
  counters: Counters;
}

/** Style hooks that make the measured focus state independent of timing. */
export const TABWALK_CSS = "*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}";

export async function runTabwalk(page: Page, maxStops = 120): Promise<TabwalkResult> {
  await page.addStyleTag({ content: TABWALK_CSS });
  await page.evaluate(() => (window as any).__e2e.tabReset());

  const stops: TabStop[] = [];
  const byUid = new Map<number, TabStop>();
  const seenOrder: number[] = [];
  let presses = 0;
  let cycleCompleted = false;
  let trap: TabwalkResult["trap"] = { detected: false, reason: null, at: null };
  let consecutiveSame = 0;
  let lastUid: number | null = null;
  let repeats = 0;
  let bodyHits = 0;

  while (presses < maxStops) {
    await page.keyboard.press("Tab");
    presses++;
    const step = (await page.evaluate(() => (window as any).__e2e.tabStep())) as {
      body: boolean;
      current: Omit<TabStop, "index"> | null;
      previousVerdict: (TabStop["indicator"] & { uid: number }) | null;
    };
    if (step.previousVerdict) {
      const prev = byUid.get(step.previousVerdict.uid);
      if (prev && !prev.indicator) prev.indicator = step.previousVerdict;
    }
    if (step.body || !step.current) {
      // Focus left the document (end of the cycle in headless Chromium) or went to <body>.
      bodyHits++;
      lastUid = null;
      if (bodyHits >= 3 && stops.length === 0) {
        trap = { detected: true, reason: "Tab never reached any element", at: presses };
        break;
      }
      continue;
    }
    const cur = step.current;
    if (cur.uid === lastUid) {
      consecutiveSame++;
      if (consecutiveSame >= 3) {
        trap = { detected: true, reason: `focus stuck on ${cur.selector} for ${consecutiveSame + 1} presses`, at: presses };
        break;
      }
      continue;
    }
    consecutiveSame = 0;
    lastUid = cur.uid;
    if (byUid.has(cur.uid)) {
      if (cur.uid === seenOrder[0]) {
        cycleCompleted = true;
        break;
      }
      repeats++;
      if (repeats >= 3) {
        trap = { detected: true, reason: `focus cycles among ${new Set(seenOrder).size} elements without leaving (last: ${cur.selector})`, at: presses };
        break;
      }
      continue;
    }
    const stop: TabStop = { index: stops.length, ...cur };
    stops.push(stop);
    byUid.set(cur.uid, stop);
    seenOrder.push(cur.uid);
  }

  const last = (await page.evaluate(() => (window as any).__e2e.tabFinish())) as (TabStop["indicator"] & { uid: number }) | null;
  if (last) {
    const s = byUid.get(last.uid);
    if (s && !s.indicator) s.indicator = last;
  }

  const visibleInteractive = (await page.evaluate(() => (window as any).__e2e.interactiveCount())) as number;
  let unreachable: TabwalkResult["unreachable"] = null;
  if (cycleCompleted) {
    const list = (await page.evaluate(() => (window as any).__e2e.interactiveList())) as { uid: number; selector: string; name: string }[];
    unreachable = list.filter((e) => !byUid.has(e.uid)).map((e) => ({ selector: e.selector, name: e.name }));
  }
  const clickOnly = (await page.evaluate(() => (window as any).__e2e.clickOnlyCandidates(15))) as TabwalkResult["clickOnly"];
  const positiveTabindex = (await page.evaluate(() => (window as any).__e2e.positiveTabindexCount())) as number;

  const noIndicator = stops.filter((s) => s.indicator && !s.indicator.strong).length;
  const counters: Counters = {
    noIndicator,
    bgOnlyIndicator: stops.filter((s) => s.indicator?.weakOnly).length,
    obscuredByFixed: stops.filter((s) => s.obscured?.kind === "fixed").length,
    coveredOrClipped: stops.filter((s) => s.obscured?.kind === "overlap").length,
    trap: trap.detected ? 1 : 0,
    unreachable: unreachable?.length ?? 0,
    focusedNotInteractive: stops.filter((s) => !s.interactive || !s.visible).length,
    positiveTabindex,
    clickOnly: clickOnly.count,
  };
  return { maxStops, presses, stops, cycleCompleted, reachedCap: !cycleCompleted && !trap.detected && presses >= maxStops, trap, visibleInteractive, unreachable, clickOnly, positiveTabindex, counters };
}

/** Informational numbers kept next to the ratcheted counters (not ratcheted themselves). */
export function tabwalkSummary(r: TabwalkResult) {
  return {
    presses: r.presses,
    tabStops: r.stops.length,
    visibleInteractive: r.visibleInteractive,
    cycleCompleted: r.cycleCompleted,
    reachedCap: r.reachedCap,
    coverage: r.visibleInteractive ? Math.round((Math.min(r.stops.filter((s) => s.interactive).length, r.visibleInteractive) / r.visibleInteractive) * 100) : null,
  };
}
