// Route drift: compares the <Route path="..."> entries found in web/src/App.tsx and web/src/main.tsx with the
// manifest in routes.ts. Regex based on purpose (keep it simple); the self-test proves it notices a new route.
import fs from "node:fs";
import path from "node:path";
import { E2E_DIR } from "../../config/shared";
import { ROUTE_DEFS, STRUCTURAL_PATTERNS } from "../routes";

export const ROUTE_SOURCES = ["App.tsx", "main.tsx"].map((f) => path.resolve(E2E_DIR, "..", "web", "src", f));

const ROUTE_PATH_RE = /<Route\b[^>]*?\bpath\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/gs;

/** Every `path` of every <Route ...> in the given source text. */
export function extractRoutePaths(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(ROUTE_PATH_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function readRoutePaths(files: string[] = ROUTE_SOURCES): string[] {
  const all = files.flatMap((f) => extractRoutePaths(fs.readFileSync(f, "utf8")));
  return [...new Set(all)].sort();
}

export interface DriftReport {
  /** In the source but not in the manifest: the manifest (and the sweep) misses this route. */
  unlisted: string[];
  /** In the manifest but no longer in the source: a stale entry. */
  stale: string[];
}

export function diffRoutes(sourcePaths: string[], manifestPatterns: string[]): DriftReport {
  const known = new Set([...manifestPatterns, ...STRUCTURAL_PATTERNS]);
  const inSource = new Set(sourcePaths);
  return {
    unlisted: sourcePaths.filter((p) => !known.has(p)),
    stale: manifestPatterns.filter((p) => !inSource.has(p)),
  };
}

export const MANIFEST_PATTERNS = [...new Set(ROUTE_DEFS.map((r) => r.pattern))].sort();
