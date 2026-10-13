// Allow-list for smoke findings. Fail closed: a finding is allowed only when an entry (in the committed
// baselines/smoke-allowlist.json, or the route's own expectedApi / knownGap in routes.ts) says why.
import fs from "node:fs";
import { PATHS } from "../../config/shared";
import type { Route } from "../routes";

export type FindingKind = "console" | "pageerror" | "http" | "requestfailed" | "overflow" | "external";

export interface Finding {
  kind: FindingKind;
  /** console text / error message / request description. */
  text: string;
  /** Request path+query (http, requestfailed) or resource URL (console). */
  path?: string;
  status?: number;
  method?: string;
}

export interface AllowEntry {
  kind: FindingKind;
  /** Route ids, or "*". */
  routes: string[] | "*";
  /** Project name globs ("classic-*"), or "*". */
  projects: string[] | "*";
  /** Regex source matched against `path` (or `text` when the finding has no path). */
  pattern?: string;
  status?: number[];
  reason: string;
  /** false = written from documentation, not yet seen in a run. */
  verified: boolean;
}

export interface AllowFile {
  schema: 1;
  description: string;
  entries: AllowEntry[];
}

export interface Judged {
  violations: Finding[];
  allowed: { finding: Finding; reason: string; verified: boolean }[];
}

export function loadAllowlist(): AllowFile {
  try {
    return JSON.parse(fs.readFileSync(PATHS.smokeAllowlist, "utf8")) as AllowFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, description: "", entries: [] };
    throw e;
  }
}

function globMatch(glob: string, value: string): boolean {
  const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(value);
}

function entryApplies(e: AllowEntry, f: Finding, routeId: string, project: string): boolean {
  if (e.kind !== f.kind) return false;
  if (e.routes !== "*" && !e.routes.includes(routeId)) return false;
  if (e.projects !== "*" && !e.projects.some((g) => globMatch(g, project))) return false;
  if (e.status && (f.status === undefined || !e.status.includes(f.status))) return false;
  if (e.pattern && !new RegExp(e.pattern).test(f.path ?? f.text)) return false;
  return true;
}

/**
 * Split findings into violations and allowed ones. Order of precedence: file allow-list, the route's
 * expectedApi (an exact status on a path pattern), then the route's knownGap (console + request findings only).
 */
export function judge(findings: Finding[], route: Route, project: string, file: AllowFile = loadAllowlist()): Judged {
  const out: Judged = { violations: [], allowed: [] };
  for (const f of findings) {
    const fromFile = file.entries.find((e) => entryApplies(e, f, route.id, project));
    if (fromFile) {
      out.allowed.push({ finding: f, reason: fromFile.reason, verified: fromFile.verified });
      continue;
    }
    const expected = (f.kind === "http" || f.kind === "console") && route.expectedApi?.find((x) => matchesExpected(x, f));
    if (expected) {
      out.allowed.push({ finding: f, reason: expected.reason, verified: true });
      continue;
    }
    if (route.knownGap && (f.kind === "http" || f.kind === "console" || f.kind === "requestfailed")) {
      out.allowed.push({ finding: f, reason: `knownGap: ${route.knownGap}`, verified: false });
      continue;
    }
    out.violations.push(f);
  }
  return out;
}

function matchesExpected(x: NonNullable<Route["expectedApi"]>[number], f: Finding): boolean {
  if (f.kind === "http") return !!f.path && x.pattern.test(f.path) && f.status !== undefined && x.status.includes(f.status);
  // The browser logs "Failed to load resource: ... status of 404" as a console error whose location is the URL.
  if (f.kind === "console") {
    if (!f.path || !x.pattern.test(f.path)) return false;
    const m = /status of (\d{3})/.exec(f.text);
    return !!m && x.status.includes(Number(m[1]));
  }
  return false;
}
