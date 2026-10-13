// "Settled" strategy for a route: the shell is mounted, no "Loading..." placeholder is left anywhere,
// no (non-stream) request is in flight, fonts and images are decoded, and the DOM has stopped mutating.
// Plain `networkidle` is not used: the Activity page keeps an SSE stream open, so it would never idle.
import { expect, test, type Page } from "@playwright/test";
import { waitForAppOrigin } from "./origin";
import type { Collector } from "./collector";
import type { Route } from "../routes";

/** Leaf elements whose whole text is a loading placeholder, e.g. "Loading...", "Fetching…". */
export const LOADING_TEXT_SOURCE = String.raw`^(loading|fetching|checking|reading|looking up|searching metadata providers)\b[^.…]{0,40}(\.\.\.|…)$`;

export interface SettleReport {
  route: string;
  requestedUrl: string;
  finalUrl: string;
  ms: number;
  loadingGone: boolean;
  leftoverLoading: string[];
  networkQuiet: boolean;
  domQuiet: boolean;
  errorBoundary: boolean;
  /** The floating scroll buttons agree with the page geometry (they lag by up to 1 s in the app itself). */
  scrollButtonsSynced: boolean;
  expectedTextSeen: boolean | null;
  attempts: number;
  /** Navigation attempts beyond the first (a hung or reset page.goto is retried; see openAndSettle). */
  navRetries: number;
}

export class SettleError extends Error {
  constructor(message: string, readonly report: SettleReport) {
    super(message);
    this.name = "SettleError";
  }
}

export interface SettleOptions {
  timeoutMs?: number;
  /** Skip the strict "must contain expectText" wait (self-test pages). */
  expectText?: string | null;
}

/** Per-attempt budget and attempts for page.goto (see openAndSettle). */
export const GOTO_TIMEOUT_MS = 45_000;
export const GOTO_ATTEMPTS = 6; // 6 x 45 s outlasts the longest stall seen (about 3 min)

/**
 * page.goto with a bounded retry. Observed in the Phase 0 runs: every few runs ALL FOUR workers' navigations hang together for
 * 85-190 s (new connections to 127.0.0.1:4173 hang, even for curl; the container keeps answering), then recover. It happened with
 * `vite preview` and with the plain node:http server that replaced it, so the app is not involved; root cause not found. A hung
 * navigation is retried instead of failing the test, and every retry is recorded (settle report `navRetries`, smoke.json, test
 * annotation) so it stays visible.
 */
export async function openAndSettle(page: Page, route: Route, collector: Collector, opts: SettleOptions = {}): Promise<SettleReport> {
  const t0 = Date.now();
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    // Before every attempt: wait (bounded) until the app origin accepts connections, and give the test that time back.
    const waited = await waitForAppOrigin();
    if (waited > 4_000) {
      const info = test.info();
      info.setTimeout(info.timeout + waited);
      info.annotations.push({ type: "app-gate", description: `waited ${Math.round(waited / 1000)} s for the app origin before navigating to ${route.href} (host loopback stall)` });
    }
    try {
      await page.goto(route.href, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      break;
    } catch (e) {
      const transient = /net::ERR_|Timeout .*exceeded|Navigation failed/.test(String((e as Error).message));
      if (!transient || attempt >= GOTO_ATTEMPTS) throw e;
      retries++;
      await page.waitForTimeout(500);
    }
  }
  const report = await settle(page, route, collector, Date.now(), opts).catch((e) => {
    if (e instanceof SettleError) e.report.navRetries = retries;
    throw e;
  });
  report.navRetries = retries;
  void t0;
  return report;
}

export async function settle(page: Page, route: Pick<Route, "id" | "href" | "role" | "ignoreLoadingText" | "redirectsTo">, collector: Collector, t0 = Date.now(), opts: SettleOptions = {}): Promise<SettleReport> {
  const timeout = opts.timeoutMs ?? 20000;
  const deadline = t0 + timeout;
  const report: SettleReport = {
    route: route.id, requestedUrl: route.href, finalUrl: "", ms: 0, loadingGone: false, leftoverLoading: [], networkQuiet: false,
    domQuiet: false, errorBoundary: false, scrollButtonsSynced: false, expectedTextSeen: null, attempts: 0, navRetries: 0,
  };
  const remaining = () => Math.max(1000, deadline - Date.now());

  // 1. The shell mounted. Admin pages render <main id="main-content">; public pages only fill #root.
  const shell = route.role === "admin" ? page.locator("main#main-content") : page.locator("#root > *").first();
  try {
    await shell.waitFor({ state: "attached", timeout: remaining() });
  } catch {
    report.finalUrl = page.url();
    report.ms = Date.now() - t0;
    throw new SettleError(`${route.id}: page shell never mounted (${route.role === "admin" ? "main#main-content" : "#root > *"}) within ${timeout} ms`, report);
  }

  // 2+3. Loop until loading placeholders are gone AND the network stayed quiet (a response can trigger the next fetch).
  const ignore = route.ignoreLoadingText ?? [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    report.attempts = attempt;
    report.networkQuiet = await collector.waitNetworkQuiet(400, remaining());
    const leftover = async () => {
      const hits = await page.evaluate((src) => (window as any).__e2e.loadingLeaves(src), LOADING_TEXT_SOURCE);
      return (hits as string[]).filter((h) => !ignore.some((re) => re.test(h)));
    };
    // Poll the placeholder check for as long as the budget allows; pages swap it for content when data arrives.
    let hits = await leftover();
    while (hits.length && Date.now() < deadline) {
      await page.waitForTimeout(100);
      hits = await leftover();
    }
    report.leftoverLoading = hits;
    report.loadingGone = hits.length === 0;
    if (report.loadingGone && collector.inFlight === 0) break;
    if (Date.now() >= deadline) break;
  }

  // 4. Fonts + images decoded, then wait for the DOM to stop mutating (bounded: live pages may never be quiet).
  await page.evaluate(async () => {
    await (document as any).fonts?.ready;
    const imgs = Array.from(document.images).filter((i) => !i.complete);
    await Promise.all(imgs.map((i) => new Promise<void>((r) => { i.addEventListener("load", () => r()); i.addEventListener("error", () => r()); setTimeout(r, 4000); })));
  });
  report.domQuiet = (await page.evaluate(() => (window as any).__e2e.domQuiet(300, 4000))) as boolean;
  // Scroll to the top first, then let the floating scroll buttons catch up (screenshots / inventory / Tab-walk all depend on them).
  await page.evaluate(() => window.scrollTo(0, 0));
  report.scrollButtonsSynced = (await page.evaluate(() => (window as any).__e2e.syncScrollButtons(800))) as boolean;

  // 5. Content that proves real seed data rendered, then the error boundary check.
  if (opts.expectText) {
    try {
      await expect(page.locator("#root")).toContainText(opts.expectText, { timeout: remaining() });
      report.expectedTextSeen = true;
    } catch {
      report.expectedTextSeen = false;
    }
  }
  report.errorBoundary = await page.getByRole("heading", { name: "Something went wrong" }).isVisible();
  report.finalUrl = new URL(page.url()).pathname + new URL(page.url()).search;
  report.ms = Date.now() - t0;
  await page.evaluate(() => window.scrollTo(0, 0));

  const problems: string[] = [];
  if (!report.loadingGone) problems.push(`placeholder text still visible: ${JSON.stringify(report.leftoverLoading.slice(0, 3))}`);
  if (!report.networkQuiet) problems.push(`network never went quiet (${collector.inFlight} request(s) in flight: ${collector.describePending().slice(0, 4).join(", ")})`);
  // A request that failed at the network level (not the guard's own abort, not a cancelled fetch) leaves the page in its empty/default state:
  // a screenshot or axe run of that would be meaningless (and as a baseline, wrong), so the route does not count as settled.
  const netFailed = collector.failedRequests.filter((f) => !/ERR_ABORTED/.test(f.text));
  if (netFailed.length) problems.push(`request(s) failed at the network level: ${netFailed.slice(0, 3).map((f) => f.text).join("; ")}`);
  if (report.errorBoundary) problems.push(`error boundary ("Something went wrong") is showing`);
  if (report.expectedTextSeen === false) problems.push(`expected text "${opts.expectText}" never appeared`);
  if (route.redirectsTo && report.finalUrl !== route.redirectsTo) problems.push(`expected redirect to ${route.redirectsTo}, ended on ${report.finalUrl}`);
  if (problems.length) throw new SettleError(`${route.id} did not settle: ${problems.join("; ")}`, report);
  return report;
}
