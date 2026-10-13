// Playwright fixtures shared by every spec: the per-project options (design, theme, viewport), the per-route
// storage state (admin session or public), the page helpers, the frozen clock, the GET-only guard and the collector.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import {
  APP_ORIGIN, FIXED_NOW, projectName, stateFile, type Design, type Role, type Theme, type ViewportName,
} from "../../config/shared";
import { applyBreakageIfRequested } from "./breakage";
import { waitForAppOrigin } from "./origin";
import { Collector } from "./collector";
import { installGetOnlyGuard, type GetOnlyGuard } from "./guard";

const BROWSER_HELPERS = fs.readFileSync(fileURLToPath(new URL("./browser-helpers.js", import.meta.url)), "utf8");

export type GuardMode = "enforce" | "observe";

/** A non-GET /api request a route is KNOWN to make and that is safe to keep blocked (the guard still aborts it; it never reaches the server). */
export interface ExpectedBlocked {
  method: string;
  /** Matched against the request path (no query). */
  pattern: RegExp;
  reason: string;
}

interface Options {
  design: Design;
  theme: Theme;
  viewportName: ViewportName;
  /** admin = logged in; public = design/theme keys only, no session token. Set per route with test.use(). */
  role: Role;
  /** enforce (default): a blocked mutation fails the test. observe: only the judge self-test uses it. */
  guardMode: GuardMode;
  /** Blocked mutations that do not fail the test (still aborted by the guard and still attached to the test). Set per route with test.use(). */
  allowBlocked: ExpectedBlocked[];
}

interface Fixtures {
  /** Milliseconds this test waited for the app origin to accept connections (see waitForAppOrigin). */
  appGate: number;
  /** "<design>-<theme>-<viewport>" */
  projectId: string;
  guard: GetOnlyGuard;
  collector: Collector;
}

/** Throws when the guard blocked a mutation (the test must fail: the page tried to change the instance). */
export function assertGuardClean(guard: GetOnlyGuard, mode: GuardMode, allow: ExpectedBlocked[] = []): void {
  if (mode !== "enforce" || guard.attempts.length === 0) return;
  const unexpected = guard.attempts.filter((a) => !allow.some((x) => x.method === a.method && x.pattern.test(a.path.split("?")[0])));
  if (unexpected.length === 0) return;
  const list = unexpected.map((a) => `${a.method} ${a.path}`).join(", ");
  throw new Error(`GET-only guard blocked ${unexpected.length} mutation request(s) to /api: ${list}`);
}

export const test = base.extend<Options & Fixtures>({
  appGate: [
    async ({}, use, testInfo) => {
      const waited = await waitForAppOrigin();
      if (waited > 4_000) {
        testInfo.setTimeout(testInfo.timeout + waited);
        testInfo.annotations.push({ type: "app-gate", description: `waited ${Math.round(waited / 1000)} s for ${APP_ORIGIN} to accept connections (host loopback stall)` });
      }
      await use(waited);
    },
    { auto: true },
  ],

  design: ["classic", { option: true }],
  theme: ["dark", { option: true }],
  viewportName: ["desktop", { option: true }],
  role: ["admin", { option: true }],
  guardMode: ["enforce", { option: true }],
  allowBlocked: [[], { option: true }],

  // The storage state is computed from design/theme/viewport/role instead of being fixed per project, so a
  // public route can run inside the same project with a session-less state.
  storageState: async ({ design, theme, viewportName, role }, use) => {
    await use(stateFile(projectName(design, theme, viewportName), role));
  },

  projectId: async ({ design, theme, viewportName }, use) => {
    await use(projectName(design, theme, viewportName));
  },

  guard: [
    async ({ context, guardMode, allowBlocked }, use, testInfo) => {
      await context.addInitScript({ content: BROWSER_HELPERS });
      await context.clock.setFixedTime(FIXED_NOW);
      await applyBreakageIfRequested(context, testInfo); // no-op unless E2E_INJECT_BREAKAGE is set (judge proof only)
      const guard = await installGetOnlyGuard(context);
      await use(guard);
      await guard.dispose();
      if (guard.attempts.length) {
        await testInfo.attach("blocked-mutations.json", { body: JSON.stringify(guard.attempts, null, 2), contentType: "application/json" });
      }
      assertGuardClean(guard, guardMode, allowBlocked);
    },
    { auto: true },
  ],

  collector: async ({ page }, use) => {
    await use(new Collector(page));
  },
});

export { expect, waitForAppOrigin };
