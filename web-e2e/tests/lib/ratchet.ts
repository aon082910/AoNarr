// Ratchet baselines (axe fingerprints, Tab-walk counters): a run may match or improve on the committed
// numbers, never get worse. Updating them is an explicit, owner-approved step (E2E_UPDATE_RATCHETS=1).
import fs from "node:fs";
import path from "node:path";
import { PATHS, parseProjectName, type Design } from "../../config/shared";

export type Counters = Record<string, number>;

export interface RatchetFile {
  schema: 1;
  kind: "axe" | "tabwalk";
  description: string;
  /** Who/what produced the numbers; filled by the update flow. */
  meta: Record<string, unknown>;
  /** entries[project][routeId] = counters */
  entries: Record<string, Record<string, Counters>>;
}

export interface Diff {
  key: string;
  baseline: number;
  current: number;
}

export interface Comparison {
  status: "no-baseline" | "ok" | "better" | "worse";
  worse: Diff[];
  better: Diff[];
  /** Project whose baseline was used (a redesign falls back to Classic of the same theme and viewport). */
  comparedAgainst: string | null;
}

export function emptyRatchet(kind: RatchetFile["kind"], description: string): RatchetFile {
  return { schema: 1, kind, description, meta: {}, entries: {} };
}

export function readRatchet(file: string, kind: RatchetFile["kind"]): RatchetFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RatchetFile;
    if (parsed.schema !== 1 || parsed.kind !== kind) throw new Error(`${file}: unexpected schema/kind`);
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyRatchet(kind, "");
    throw e;
  }
}

export function writeRatchet(file: string, data: RatchetFile): void {
  // Stable key order so a re-run with identical numbers produces an identical file (clean git diff).
  const sorted: RatchetFile = { ...data, entries: {} };
  for (const project of Object.keys(data.entries).sort()) {
    sorted.entries[project] = {};
    for (const route of Object.keys(data.entries[project]).sort()) {
      const c = data.entries[project][route];
      sorted.entries[project][route] = Object.fromEntries(Object.keys(c).sort().map((k) => [k, c[k]]));
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + "\n");
}

/** Compare numbers where higher = worse. A key missing on one side counts as 0 there. */
export function compareCounters(baseline: Counters, current: Counters): { worse: Diff[]; better: Diff[] } {
  const worse: Diff[] = [];
  const better: Diff[] = [];
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const b = baseline[key] ?? 0;
    const c = current[key] ?? 0;
    if (c > b) worse.push({ key, baseline: b, current: c });
    else if (c < b) better.push({ key, baseline: b, current: c });
  }
  return { worse, better };
}

/** Baseline entry for this project/route, falling back to Classic (same theme+viewport) for a redesign. */
export function baselineFor(file: RatchetFile, project: string, route: string): { counters: Counters; from: string } | null {
  const own = file.entries[project]?.[route];
  if (own) return { counters: own, from: project };
  const parts = parseProjectName(project);
  if (parts.design !== "classic") {
    const classic = `classic-${parts.theme}-${parts.viewport}`;
    const fallback = file.entries[classic]?.[route];
    if (fallback) return { counters: fallback, from: classic };
  }
  return null;
}

export function compareToRatchet(file: RatchetFile, project: string, route: string, current: Counters): Comparison {
  const base = baselineFor(file, project, route);
  if (!base) return { status: "no-baseline", worse: [], better: [], comparedAgainst: null };
  const { worse, better } = compareCounters(base.counters, current);
  return { status: worse.length ? "worse" : better.length ? "better" : "ok", worse, better, comparedAgainst: base.from };
}

/** Classic is a hard gate; the redesigns report only, until E2E_STRICT_RATCHETS=1. */
export function ratchetIsBlocking(design: Design): boolean {
  return design === "classic" || process.env.E2E_STRICT_RATCHETS === "1";
}

/** Result files written per test: .tmp/<kind>/<project>/<route>.json */
export interface RatchetResultFile {
  project: string;
  route: string;
  counters: Counters;
  /** The route's data changes with every test login (see routes.ts `ratchet`): recorded for reports, never ratcheted. */
  reportOnly?: boolean;
}

export function resultPath(dir: string, project: string, route: string): string {
  return path.join(dir, project, `${route}.json`);
}

/** Merge result files newer than `sinceMs` into the baseline (called once, from global teardown). */
export function mergeResultsIntoRatchet(kind: RatchetFile["kind"], resultsDir: string, baselineFile: string, sinceMs: number, meta: Record<string, unknown>): number {
  if (!fs.existsSync(resultsDir)) return 0;
  const base = readRatchet(baselineFile, kind);
  let merged = 0;
  for (const project of fs.readdirSync(resultsDir)) {
    const dir = path.join(resultsDir, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (!f.endsWith(".json") || fs.statSync(full).mtimeMs < sinceMs) continue;
      const r = JSON.parse(fs.readFileSync(full, "utf8")) as RatchetResultFile;
      if (r.reportOnly) continue;
      (base.entries[r.project] ??= {})[r.route] = r.counters;
      merged++;
    }
  }
  if (merged) {
    base.meta = { ...base.meta, ...meta };
    writeRatchet(baselineFile, base);
  }
  return merged;
}
