// Fails when web/src/App.tsx or web/src/main.tsx gain a route path that routes.ts does not list (and when the
// manifest keeps one the source dropped). Pure file checks: no browser, no seeded instance, no server.
import { expect, test } from "@playwright/test";
import { MANIFEST_PATTERNS, ROUTE_SOURCES, diffRoutes, readRoutePaths } from "./lib/drift";
import { ROUTE_DEFS, TABWALK_ROUTE_IDS } from "./routes";

test("every route path in App.tsx / main.tsx is in the manifest", () => {
  const { unlisted } = diffRoutes(readRoutePaths(), MANIFEST_PATTERNS);
  expect(unlisted, `Add these paths to ROUTE_DEFS in tests/routes.ts (found in ${ROUTE_SOURCES.join(" / ")}): ${unlisted.join(", ")}`).toEqual([]);
});

test("the manifest lists no route the source dropped", () => {
  const { stale } = diffRoutes(readRoutePaths(), MANIFEST_PATTERNS);
  expect(stale, `Remove or rename these manifest patterns, they are not <Route path> values any more: ${stale.join(", ")}`).toEqual([]);
});

test("manifest entries are well formed", () => {
  const ids = ROUTE_DEFS.map((r) => r.id);
  expect(new Set(ids).size, "route ids must be unique").toBe(ids.length);
  // Resolve every URL with a stand-in params object: no unresolved :param, no undefined/NaN.
  const fake = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? 7 : undefined) }) as never;
  for (const r of ROUTE_DEFS) {
    const href = r.url(fake);
    expect(href, `${r.id} -> ${href}`).toMatch(/^\/[^:]*$/);
    expect(href, r.id).not.toMatch(/undefined|null|NaN/);
    if (r.variantOf) expect(ROUTE_DEFS.some((o) => o.id === r.variantOf && o.pattern === r.pattern), `${r.id}: variantOf must name an entry with the same pattern`).toBe(true);
  }
  expect(readRoutePaths().length, "regex found no routes at all").toBeGreaterThan(40);
});

test("the tab-walk set is the ~12 representative routes", () => {
  expect(TABWALK_ROUTE_IDS).toHaveLength(12);
});
