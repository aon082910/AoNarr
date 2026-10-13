// PROOF THAT THE JUDGE CAN FAIL. Every check here runs the same helper the sweep specs use (tests/lib/*) twice:
//   1. on the clean page (positive control: must NOT be flagged), and
//   2. on the same page with a deliberately broken stylesheet / script injected through the browser
//      (must be flagged).
// A test passes only when the broken page is flagged AND the clean page is not. Nothing under web/ is touched:
// the damage exists only in the page, in memory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as pure, expect as pexpect } from "@playwright/test";
import { runAxe } from "./lib/axe";
import { judge } from "./lib/allowlist";
import { collectInventory, diffInventory, hasOverflow, inventoryDropped, measureOverflow } from "./lib/checks";
import { MANIFEST_PATTERNS, diffRoutes, extractRoutePaths, readRoutePaths, ROUTE_SOURCES } from "./lib/drift";
import { assertGuardClean, expect, test } from "./lib/fixtures";
import {
  baselineFor, compareCounters, compareToRatchet, mergeResultsIntoRatchet, readRatchet, writeRatchet, type RatchetFile,
} from "./lib/ratchet";
import { screenshotOptions } from "./lib/screens";
import { SettleError, openAndSettle } from "./lib/settle";
import { runTabwalk } from "./lib/tabwalk";
import { resolveRoutes, type Route } from "./routes";

const ROUTES = resolveRoutes();
const byId = (id: string): Route => {
  const r = ROUTES.find((x) => x.id === id);
  if (!r) throw new Error(`route ${id} missing from the manifest`);
  return r;
};
const PAGE_ROUTE = "library-type";
const evidence = (info: import("@playwright/test").TestInfo, text: string) => info.annotations.push({ type: "evidence", description: text });
const PROJECT = "classic-dark-desktop";

// ---------------------------------------------------------------------------------------------------------
// Pure logic (no browser): drift, allow-list, ratchet
// ---------------------------------------------------------------------------------------------------------
pure.describe("pure logic", () => {
  pure("drift: a new <Route path> is reported as unlisted, a removed one as stale", () => {
    const real = ROUTE_SOURCES.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const base = diffRoutes([...new Set(extractRoutePaths(real))], MANIFEST_PATTERNS);
    pexpect(base.unlisted, "control: the real source must have no drift").toEqual([]);
    pexpect(base.stale, "control: the real source must have no stale entries").toEqual([]);

    const withNew = real + '\n<Route path="/e2e-brand-new-page" element={<X />} />\n{isAdmin && <Route path="/e2e/:thing/edit" element={<Y />} />}';
    const drift = diffRoutes([...new Set(extractRoutePaths(withNew))], MANIFEST_PATTERNS);
    pexpect(drift.unlisted).toEqual(["/e2e-brand-new-page", "/e2e/:thing/edit"]);

    const without = real.replace(/\{isAdmin && <Route path="\/missing"[^\n]*\n/, "");
    pexpect(without.length, "control: the removal pattern must match").toBeLessThan(real.length);
    pexpect(diffRoutes([...new Set(extractRoutePaths(without))], MANIFEST_PATTERNS).stale).toEqual(["/missing"]);
    pexpect(readRoutePaths().length).toBeGreaterThan(40);
  });

  pure("allow-list fails closed", () => {
    const share = byId("share-expired");
    const plain = byId("library-type");
    const gap = byId("discover");
    const empty = { schema: 1 as const, description: "", entries: [] };
    const f404 = { kind: "http" as const, text: "GET /api/share/x -> 404", path: "/api/share/abc", status: 404 };

    pexpect(judge([f404], plain, PROJECT, empty).violations, "a 404 on an ordinary route is a violation").toHaveLength(1);
    pexpect(judge([f404], share, PROJECT, empty).allowed, "the expired-share 404 is expected on that route").toHaveLength(1);
    pexpect(judge([{ ...f404, status: 500 }], share, PROJECT, empty).violations, "a 500 is not the expected 404").toHaveLength(1);
    pexpect(judge([{ ...f404, path: "/api/other" }], share, PROJECT, empty).violations, "another path is not covered").toHaveLength(1);
    pexpect(judge([{ kind: "pageerror", text: "boom" }], gap, PROJECT, empty).violations, "a known-gap route may fail requests but not throw").toHaveLength(1);
    pexpect(judge([{ kind: "overflow", text: "x" }], gap, PROJECT, empty).violations, "overflow is never excused by knownGap").toHaveLength(1);
    pexpect(judge([f404], gap, PROJECT, empty).allowed, "knownGap excuses request failures").toHaveLength(1);
    const withEntry = { ...empty, entries: [{ kind: "http" as const, routes: ["library-type"], projects: ["classic-*"], pattern: "^/api/share/", status: [404], reason: "test", verified: true }] };
    pexpect(judge([f404], plain, PROJECT, withEntry).allowed).toHaveLength(1);
    pexpect(judge([f404], plain, "midnight-dark-desktop", withEntry).violations, "project glob must restrict the entry").toHaveLength(1);
  });

  pure("ratchet: worse / better / missing, Classic fallback, stable files", () => {
    pexpect(compareCounters({ a: 2, b: 1 }, { a: 2, b: 1 }).worse).toEqual([]);
    pexpect(compareCounters({ a: 2 }, { a: 3 }).worse).toEqual([{ key: "a", baseline: 2, current: 3 }]);
    pexpect(compareCounters({ a: 2 }, { a: 2, newRule: 1 }).worse, "a rule absent from the baseline counts as 0").toEqual([{ key: "newRule", baseline: 0, current: 1 }]);
    pexpect(compareCounters({ a: 2, gone: 4 }, { a: 1 }).better.map((d) => d.key).sort()).toEqual(["a", "gone"]);

    const file: RatchetFile = { schema: 1, kind: "axe", description: "", meta: {}, entries: { "classic-dark-desktop": { dashboard: { "color-contrast": 3 } } } };
    pexpect(compareToRatchet(file, "classic-dark-desktop", "dashboard", { "color-contrast": 4 }).status).toBe("worse");
    pexpect(compareToRatchet(file, "classic-dark-desktop", "dashboard", { "color-contrast": 3 }).status).toBe("ok");
    pexpect(compareToRatchet(file, "classic-dark-desktop", "dashboard", {}).status).toBe("better");
    pexpect(compareToRatchet(file, "classic-dark-desktop", "settings", {}).status).toBe("no-baseline");
    pexpect(baselineFor(file, "midnight-dark-desktop", "dashboard")?.from, "a redesign is compared with Classic of the same theme+viewport").toBe("classic-dark-desktop");
    pexpect(baselineFor(file, "midnight-light-desktop", "dashboard"), "no Classic light entry -> no fallback").toBeNull();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ratchet-"));
    try {
      const results = path.join(dir, "axe");
      const rf = path.join(results, "classic-dark-desktop");
      fs.mkdirSync(rf, { recursive: true });
      fs.writeFileSync(path.join(rf, "b.json"), JSON.stringify({ project: "classic-dark-desktop", route: "b", counters: { z: 1, a: 2 } }));
      fs.writeFileSync(path.join(rf, "a.json"), JSON.stringify({ project: "classic-dark-desktop", route: "a", counters: { a: 1 } }));
      const out = path.join(dir, "baseline.json");
      pexpect(mergeResultsIntoRatchet("axe", results, out, 0, { note: "selftest" })).toBe(2);
      const first = fs.readFileSync(out, "utf8");
      writeRatchet(out, readRatchet(out, "axe"));
      pexpect(fs.readFileSync(out, "utf8"), "write -> read -> write must be byte-identical").toBe(first);
      pexpect(Object.keys(JSON.parse(first).entries["classic-dark-desktop"])).toEqual(["a", "b"]);
      pexpect(mergeResultsIntoRatchet("axe", results, out, Date.now() + 60_000, {}), "results older than the run are not merged").toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Browser checks: clean page passes, broken page is flagged
// ---------------------------------------------------------------------------------------------------------
test.describe("broken page is detected", () => {
  const route = byId(PAGE_ROUTE);

  test("overflow: body{width:200vw} is flagged, the clean page is not", async ({ page, collector }, testInfo) => {
    await openAndSettle(page, route, collector);
    const clean = await measureOverflow(page);
    expect(hasOverflow(clean), `control: clean page must not overflow (${JSON.stringify(clean)})`).toBe(false);

    await page.addStyleTag({ content: "body{overflow-x:visible!important;width:200vw!important}" });
    const broken = await measureOverflow(page);
    expect(hasOverflow(broken), JSON.stringify(broken)).toBe(true);
    expect(broken.overflowPx).toBeGreaterThan(500);
    expect(broken.offenders.length, "the offender list names the elements").toBeGreaterThan(0);
    evidence(testInfo, `overflowPx clean ${clean.overflowPx} -> broken ${broken.overflowPx}; ${broken.offenders.length} offender(s), widest ${broken.offenders[0].selector}`);
  });

  test("inventory: .sidebar{display:none} drops text and controls, an unchanged page drops nothing", async ({ page, collector }, testInfo) => {
    await openAndSettle(page, route, collector);
    const before = await collectInventory(page);
    const again = await collectInventory(page);
    expect(inventoryDropped(diffInventory(before, again)), "control: the same page twice").toBe(false);
    expect(before.interactive.length, "control: the inventory sees the sidebar links").toBeGreaterThan(10);

    await page.addStyleTag({ content: ".sidebar{display:none!important}" });
    const after = await collectInventory(page);
    const diff = diffInventory(before, after);
    expect(inventoryDropped(diff)).toBe(true);
    expect(diff.missingInteractive.length).toBeGreaterThan(5);
    expect(diff.missingText.length).toBeGreaterThan(5);
    evidence(testInfo, `inventory: ${before.interactive.length} controls / ${before.textLines.length} text lines before; sidebar hidden drops ${diff.missingInteractive.length} controls and ${diff.missingText.length} text lines`);
  });

  test("collector + allow-list: console error, uncaught exception, 404 request and an outside host are all violations", async ({ page, collector, projectId }, testInfo) => {
    await openAndSettle(page, route, collector);
    expect(judge(collector.findings(), route, projectId).violations, "control: the clean page has no violations").toEqual([]);

    collector.reset();
    await page.route("https://e2e-selftest.invalid/**", (r) => r.abort()); // never leaves the machine
    await page.evaluate(() => {
      console.error("e2e selftest console error");
      // An unhandled rejection is reported as a pageerror. (An exception thrown inside a setTimeout callback is NOT:
      // with the fixed clock installed, Playwright's clock catches it and logs it as console.error, which the
      // console check catches too.)
      Promise.reject(new Error("e2e selftest uncaught"));
      fetch("/api/__e2e_selftest_404");
      fetch("https://e2e-selftest.invalid/ping").catch(() => {});
    });
    await collector.waitNetworkQuiet(300, 5000);
    await page.waitForTimeout(300);
    const kinds = new Set(judge(collector.findings(), route, projectId).violations.map((v) => v.kind));
    for (const k of ["console", "pageerror", "http", "external"]) expect([...kinds], `kind ${k} must be flagged`).toContain(k);
    evidence(testInfo, `clean page: 0 violations; injected page: ${[...kinds].join(", ")}`);
  });

  test.describe("GET-only guard", () => {
    test.use({ guardMode: "observe" });

    test("every POST/PUT/PATCH/DELETE to /api is blocked and recorded, GET passes, enforce mode throws", async ({ page, collector, guard }, testInfo) => {
      await openAndSettle(page, route, collector);
      const passedBefore = guard.passed;
      const outcome = await page.evaluate(async () => {
        const out: string[] = [];
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          try {
            await fetch("/api/__e2e_guard_probe", { method, headers: { "Content-Type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
            out.push(`${method}:reached-server`);
          } catch {
            out.push(`${method}:blocked`);
          }
        }
        out.push(`beacon:${navigator.sendBeacon("/api/__e2e_guard_probe", "x") ? "queued" : "refused"}`);
        out.push(`GET:${(await fetch("/api/__e2e_guard_probe")).status}`);
        return out;
      });
      expect(outcome.slice(0, 4)).toEqual(["POST:blocked", "PUT:blocked", "PATCH:blocked", "DELETE:blocked"]);
      expect(outcome[outcome.length - 1], "a GET is not blocked: the server answers it (401 without a session header, 404 with one)").toMatch(/^GET:(401|404)$/);
      expect(guard.attempts.map((a) => a.method).sort()).toEqual(expect.arrayContaining(["DELETE", "PATCH", "POST", "PUT"]));
      expect(guard.attempts.every((a) => a.path === "/api/__e2e_guard_probe")).toBe(true);
      expect(guard.passed).toBeGreaterThan(passedBefore);
      expect(() => assertGuardClean(guard, "enforce"), "enforce mode must throw").toThrow(/blocked \d+ mutation/);
      expect(() => assertGuardClean(guard, "observe")).not.toThrow();
      evidence(testInfo, `page-side results ${outcome.join(" ")}; guard recorded ${guard.attempts.length} attempt(s): ${guard.attempts.map((a) => a.method).join(",")}`);
    });
  });

  test("axe: low contrast makes the ratchet go 'worse'; the clean page re-run stays 'ok'", async ({ page, collector }, testInfo) => {
    await openAndSettle(page, route, collector);
    const clean = await runAxe(page);
    const baseline: RatchetFile = { schema: 1, kind: "axe", description: "selftest", meta: {}, entries: { [PROJECT]: { [PAGE_ROUTE]: clean.fingerprint } } };
    const rerun = await runAxe(page);
    expect(compareToRatchet(baseline, PROJECT, PAGE_ROUTE, rerun.fingerprint).status, "control: identical page").toBe("ok");

    await page.addStyleTag({ content: "#root,#root *{color:#777!important;background-color:#808080!important}" });
    const broken = await runAxe(page);
    const cmp = compareToRatchet(baseline, PROJECT, PAGE_ROUTE, broken.fingerprint);
    expect(cmp.status).toBe("worse");
    expect(cmp.worse.map((d) => d.key)).toContain("color-contrast");
    evidence(testInfo, `axe clean ${JSON.stringify(clean.fingerprint)} -> broken ${JSON.stringify(broken.fingerprint)}`);
  });

  test("axe: target-size is enabled and flags two adjacent 6px targets", async ({ page, collector }, testInfo) => {
    await openAndSettle(page, route, collector);
    const clean = await runAxe(page);
    expect(clean.ruleIdsRun, "target-size is off by default; it must have been evaluated").toContain("target-size");
    expect(clean.ruleIdsRun).toContain("color-contrast");

    await page.evaluate(() => {
      const box = document.createElement("div");
      box.style.cssText = "position:absolute;top:120px;left:420px;z-index:5";
      box.innerHTML = '<a href="#a" aria-label="a" style="display:inline-block;width:6px;height:6px;background:#f00"></a><a href="#b" aria-label="b" style="display:inline-block;width:6px;height:6px;background:#f00"></a>';
      document.body.appendChild(box);
    });
    const broken = await runAxe(page);
    const cmp = compareToRatchet({ schema: 1, kind: "axe", description: "", meta: {}, entries: { [PROJECT]: { [PAGE_ROUTE]: clean.fingerprint } } }, PROJECT, PAGE_ROUTE, broken.fingerprint);
    expect(cmp.status).toBe("worse");
    expect(cmp.worse.map((d) => d.key)).toContain("target-size");
    evidence(testInfo, `target-size nodes clean ${clean.fingerprint["target-size"] ?? 0} -> broken ${broken.fingerprint["target-size"]}`);
  });

  test("tab-walk: removed focus ring, a fixed overlay and a keyboard trap are each flagged; the clean page is stable", async ({ page, collector }, testInfo) => {
    const MAX = 40;
    // A new navigation gives a new document: every injected style / listener from the previous case is gone.
    const fresh = async () => {
      await openAndSettle(page, route, collector);
    };
    await openAndSettle(page, route, collector);
    const clean = await runTabwalk(page, MAX);
    expect(clean.stops.length, "control: the walk reaches controls").toBeGreaterThan(5);
    expect(clean.counters.trap, "control: no trap on the clean page").toBe(0);
    evidence(testInfo, `clean walk: ${clean.stops.length} stops / ${clean.visibleInteractive} visible interactive, cycleCompleted=${clean.cycleCompleted}, counters ${JSON.stringify(clean.counters)}`);

    await fresh();
    const cleanAgain = await runTabwalk(page, MAX);
    expect(compareCounters(clean.counters, cleanAgain.counters).worse, "control: the walker is deterministic").toEqual([]);

    await test.step("focus indicator removed", async () => {
      await fresh();
      await page.addStyleTag({ content: "*,*::before,*::after{outline:none!important;box-shadow:none!important;border-color:currentColor!important}" });
      const broken = await runTabwalk(page, MAX);
      expect(broken.counters.noIndicator, `noIndicator ${clean.counters.noIndicator} -> ${broken.counters.noIndicator}`).toBeGreaterThan(clean.counters.noIndicator);
      expect(compareCounters(clean.counters, broken.counters).worse.map((d) => d.key)).toContain("noIndicator");
      evidence(testInfo, `no focus ring: noIndicator ${clean.counters.noIndicator} -> ${broken.counters.noIndicator}`);
    });

    await test.step("focused element covered by a fixed widget", async () => {
      await fresh();
      await page.evaluate(() => {
        const veil = document.createElement("div");
        veil.id = "e2e-selftest-veil";
        veil.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent";
        document.body.appendChild(veil);
      });
      const broken = await runTabwalk(page, MAX);
      expect(broken.counters.obscuredByFixed, `obscuredByFixed ${clean.counters.obscuredByFixed} -> ${broken.counters.obscuredByFixed}`).toBeGreaterThan(clean.counters.obscuredByFixed);
      expect(compareCounters(clean.counters, broken.counters).worse.map((d) => d.key)).toContain("obscuredByFixed");
      evidence(testInfo, `fixed veil: obscuredByFixed ${clean.counters.obscuredByFixed} -> ${broken.counters.obscuredByFixed}`);
    });

    await test.step("keyboard trap", async () => {
      await fresh();
      await page.evaluate(() => {
        document.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              (document.querySelector("a[href],button") as HTMLElement | null)?.focus();
            }
          },
          true,
        );
      });
      const broken = await runTabwalk(page, MAX);
      expect(broken.trap.detected, JSON.stringify(broken.trap)).toBe(true);
      expect(compareCounters(clean.counters, broken.counters).worse.map((d) => d.key)).toContain("trap");
      evidence(testInfo, `trap: ${broken.trap.reason}`);
    });
  });

  test("screenshot: the same toHaveScreenshot options pass on the clean page and fail with the sidebar removed", async ({ page, collector }, testInfo) => {
    await openAndSettle(page, route, collector);
    const name = ["selftest", "library-type.png"];
    const golden = testInfo.snapshotPath(...name);
    fs.mkdirSync(path.dirname(golden), { recursive: true });
    fs.writeFileSync(golden, await page.screenshot(screenshotOptions(page, route)));
    await expect(page, "control: the clean page matches its own golden").toHaveScreenshot(name, screenshotOptions(page, route));

    await page.addStyleTag({ content: ".sidebar{display:none!important}" });
    await expect(page, "the broken page must NOT match").not.toHaveScreenshot(name, screenshotOptions(page, route));
  });

  test("settle: a page stuck on a placeholder is reported as not settled; the normal page settles", async ({ page, collector }, testInfo) => {
    const detail = byId("media-detail");
    const ok = await openAndSettle(page, detail, collector);
    expect(ok.loadingGone && ok.networkQuiet && !ok.errorBoundary, JSON.stringify(ok)).toBe(true);

    let held = 0;
    await page.route((url) => url.pathname.startsWith("/api/media"), () => {
      held++; // never answered: the page keeps its placeholder
    });
    const stuck = await openAndSettle(page, detail, collector, { timeoutMs: 4000 }).then(
      () => null,
      (e) => e,
    );
    expect(held, "the held request must have been seen").toBeGreaterThan(0);
    expect(stuck).toBeInstanceOf(SettleError);
    expect((stuck as SettleError).report.loadingGone && (stuck as SettleError).report.networkQuiet, "must not claim to be settled").toBe(false);
    evidence(testInfo, `normal page settled in ${ok.ms} ms; stuck page: ${(stuck as SettleError).message}`);
  });
});
