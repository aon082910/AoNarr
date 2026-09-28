/**
 * Lightweight, in-memory tracking for admin-triggered background jobs that used to be pure
 * fire-and-forget ("check the Logs page later") — Scan & Import and Match All Providers
 * (server/src/services/libraryScan.ts). Modeled directly on services/mediaAnalysis.ts's
 * `AnalysisProgress`/`getAnalysisProgress()` pattern, generalized to track several jobs at once
 * (a scan and a match-providers run, or two different library types, can be in flight
 * simultaneously) rather than one single global slot — the client's minimizable progress widget
 * lists every entry this returns.
 *
 * Deliberately NOT the source of truth for "is a scan/match already running" — libraryScan.ts's own
 * `scansInProgress` Set already guards that (with real correctness consequences documented on that
 * Set — see its comment), and this module doesn't replace or duplicate that logic. This is purely
 * for UI progress reporting; a caller with its own overlap guard checks that first and only starts
 * a job here once it knows the real work is actually going ahead.
 */

export interface BackgroundJobProgress {
  id: string;
  kind: "scan" | "matchProviders" | "refresh" | "organize";
  type: string;
  label: string;
  total: number;
  done: number;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

const jobs = new Map<string, BackgroundJobProgress>();

/** A finished job stays visible for a little while after completion (so a client polling right
 * after it ends still sees the 100%/error state instead of the entry just vanishing) — pruned
 * lazily on the next listBackgroundJobs() call rather than with its own timer. */
const FINISHED_RETENTION_MS = 60_000;

function jobId(kind: BackgroundJobProgress["kind"], type: string): string {
  return `${kind}:${type}`;
}

/** Starts tracking one run. Throws if this exact (kind, type) pair is already marked running —
 * callers should only reach this after their own overlap guard (if any) has already confirmed the
 * work is really starting, so this should be unreachable in practice rather than a real race. */
export function startBackgroundJob(kind: BackgroundJobProgress["kind"], type: string, label: string, total = 0): string {
  const id = jobId(kind, type);
  if (jobs.get(id)?.running) throw new Error(`A ${kind} job for "${type}" is already running`);
  jobs.set(id, { id, kind, type, label, total, done: 0, running: true, startedAt: Date.now(), finishedAt: null, error: null });
  return id;
}

/** Sets total/done directly — used once the real item count is known (e.g. a scan's file walk
 * finishes) rather than guessed at start time. A no-op if the job isn't tracked (already finished,
 * or was never started — e.g. a per-item scan that intentionally never calls startBackgroundJob),
 * which is what lets scanAndImportLibraryInner call this unconditionally regardless of whether the
 * particular scan it's part of created a tracked job at all. */
export function updateBackgroundJob(kind: BackgroundJobProgress["kind"], type: string, patch: Partial<Pick<BackgroundJobProgress, "total" | "done">>): void {
  const job = jobs.get(jobId(kind, type));
  if (job) Object.assign(job, patch);
}

export function incrementBackgroundJobDone(kind: BackgroundJobProgress["kind"], type: string, by = 1): void {
  const job = jobs.get(jobId(kind, type));
  if (job) job.done += by;
}

export function finishBackgroundJob(id: string, error?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.running = false;
  job.finishedAt = Date.now();
  job.error = error ?? null;
}

export function isBackgroundJobRunning(kind: BackgroundJobProgress["kind"], type: string): boolean {
  return jobs.get(jobId(kind, type))?.running ?? false;
}

/** Every tracked job, newest-started first — finished entries older than FINISHED_RETENTION_MS are
 * dropped first so a long-uptime instance doesn't accumulate one dead row per run forever. */
export function listBackgroundJobs(): BackgroundJobProgress[] {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.running && job.finishedAt !== null && now - job.finishedAt > FINISHED_RETENTION_MS) jobs.delete(id);
  }
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}
