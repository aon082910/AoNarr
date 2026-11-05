import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { log } from "./logger.js";
import { getSetting, setSetting } from "./settingsStore.js";
import { db } from "../db/index.js";

export interface JobDef {
  key: string;
  name: string;
  /** "cron" jobs run on a standard 5-field cron expression; "interval" jobs run every N seconds
   * (for sub-minute cadences like queue polling, which cron can't express). */
  scheduleType: "cron" | "interval";
  defaultSchedule: string; // cron expression, or a plain integer (seconds) for interval jobs
  /** Receives an AbortSignal — loop-based jobs check it between iterations for best-effort cancel.
   * Jobs that are a handful of monolithic awaits can't meaningfully abort mid-flight; for those,
   * the signal is simply unused and "cancel" only stops it from being waited on further. */
  run: (signal: AbortSignal, info?: { manual: boolean }) => Promise<void>;
  /** A job that walks the library or the disks (a scan, a media check, archival, housekeeping). At most
   * one heavy job runs at a time and the rest wait their turn, as Sonarr's command queue will not start a
   * disk-access command while another runs; 19 jobs used to start together at midnight. */
  heavy?: boolean;
  /** A weekly job a restart can skip: when its last recorded run is older than its previous scheduled time,
   * it runs once shortly after startup (Sonarr runs overdue tasks right after a restart). */
  catchUp?: boolean;
  /** The job the app cannot work without (the queue poll imports every finished download): it has no off switch. */
  essential?: boolean;
  /** Starts switched off until the admin switches it on: a job that writes files on its own is not something an upgrade starts ("Run now" works). */
  defaultOff?: boolean;
}

interface JobState {
  schedule: string;
  /** Switched on (the default). A job switched off has no timer and no catch-up run; "Run now" still works. */
  enabled: boolean;
  task: cron.ScheduledTask | ReturnType<typeof setInterval> | null;
  running: boolean;
  /** Waiting for the heavy-job slot. */
  queued: boolean;
  /** This run holds the heavy-job slot (cleared when it is released, by the end of the run or by the cancel watchdog). */
  holdsSlot: boolean;
  /** The newest recorded run that completed (or failed on its own): a run a restart cut off does not count. */
  lastFinishedAt: string | null;
  /** Any run of this job is recorded in job_runs. */
  hasHistory: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "cancelled" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  controller: AbortController | null;
}

const defs = new Map<string, JobDef>();
const state = new Map<string, JobState>();
/** Set by stopAllJobs for a shutdown or a backup restore: from then on nothing may start a job, not
 * even "Run now", since an import started mid-restore writes into a database being replaced. */
let stopped = false;

function settingKey(key: string): string {
  return `jobSchedule_${key}`;
}

function enabledKey(key: string): string {
  return `jobEnabled_${key}`;
}

export function registerJob(def: JobDef): void {
  defs.set(def.key, def);
  const schedule = getSetting(settingKey(def.key)) || def.defaultSchedule;
  state.set(def.key, {
    schedule,
    enabled: def.essential ? true : getSetting(enabledKey(def.key)) ? getSetting(enabledKey(def.key)) !== "0" : !def.defaultOff,
    task: null,
    running: false,
    queued: false,
    holdsSlot: false,
    lastFinishedAt: null,
    hasHistory: false,
    startedAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    controller: null,
  });
}

/** The heavy-job slot: one at a time, the rest wait in the order they were triggered. */
let heavyHolder: string | null = null;
const heavyWaiters: { key: string; wake: (granted: boolean) => void }[] = [];

function acquireHeavySlot(key: string): Promise<boolean> {
  if (heavyHolder === null) {
    heavyHolder = key;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => heavyWaiters.push({ key, wake: resolve }));
}

function releaseHeavySlot(): void {
  const next = heavyWaiters.shift();
  if (!next) {
    heavyHolder = null;
    return;
  }
  heavyHolder = next.key;
  next.wake(true);
}

function wakeHeavyWaiters(): void {
  // stopAllJobs and cancelJob: the ones still waiting give up instead of starting a job nobody wants.
  for (const waiter of heavyWaiters.splice(0)) waiter.wake(false);
}

/** Every run is also written to job_runs (best effort: a database that is not up yet, or a failing insert,
 * must never stop a job), so the Jobs page and Health survive a restart. Fire and forget: the insert is
 * started in the same tick (SQLite runs it at once) and its row id is awaited only when the run ends. */
function recordRunStart(key: string, startedAt: string): Promise<number | null> {
  try {
    return db
      .prepare("INSERT INTO job_runs (job_key, started_at, status) VALUES (?, ?, 'running')")
      .run(key, startedAt)
      .then((r) => (r.lastInsertRowid == null ? null : Number(r.lastInsertRowid)))
      .catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function recordRunEnd(rowId: Promise<number | null>, status: string, error: string | null, durationMs: number): void {
  rowId
    .then((id) => {
      if (id === null) return;
      return db
        .prepare("UPDATE job_runs SET finished_at = ?, status = ?, error = ?, duration_ms = ? WHERE id = ?")
        .run(new Date().toISOString(), status, error, durationMs, id);
    })
    .catch(() => {});
}

/** A whole row for a run that was not written when it started (see INTERVAL_RECORD_MS). */
function recordFinishedRun(key: string, startedAt: string, status: string, error: string | null, durationMs: number): void {
  try {
    db.prepare("INSERT INTO job_runs (job_key, started_at, finished_at, status, error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, startedAt, new Date().toISOString(), status, error, durationMs)
      .catch(() => {});
  } catch {
    // no database yet
  }
}

/**
 * An interval job (the queue poll runs every 20 seconds: 130,000 rows a month) is recorded only when a run failed,
 * was cancelled or took longer than this, so its run list shows what needs a look, not 4,000 identical rows a day.
 */
const INTERVAL_RECORD_MS = 10_000;

export type ExecuteOutcome<T> =
  | { status: "ran"; value: T }
  | { status: "skipped"; reason: "already-running" | "stopped" | "unknown" | "cancelled" | "busy"; holder?: string };

/**
 * Runs a job (its own `run`, or `runner` when a caller wants the result back, as the System page's manual
 * buttons do) under the registry's rules: never beside itself, one heavy job at a time, state and history
 * recorded. `throwOnError` is for those manual callers; a scheduled run logs a failure and carries on.
 */
async function execute<T = void>(
  key: string,
  runner?: (signal: AbortSignal) => Promise<T>,
  throwOnError = false,
  options: { immediate?: boolean; manual?: boolean } = {}
): Promise<ExecuteOutcome<T>> {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s) return { status: "skipped", reason: "unknown" };
  if (stopped) return { status: "skipped", reason: "stopped" };
  if (s.running || s.queued) {
    log.info(`[jobs] "${def.name}" is already ${s.running ? "running" : "waiting to run"} — skipping this trigger`);
    return { status: "skipped", reason: "already-running" };
  }
  // A caller that is waiting for the answer (a button on the System page) must not be held in the queue behind
  // a library scan that can run for hours: it is told at once which job has the slot.
  if (def.heavy && options.immediate && heavyHolder !== null) return { status: "skipped", reason: "busy", holder: defs.get(heavyHolder)?.name ?? heavyHolder };

  const controller = new AbortController();
  s.controller = controller;
  if (def.heavy) {
    s.queued = true;
    if (heavyHolder !== null) log.info(`[jobs] "${def.name}" waits for "${heavyHolder}" to finish (one heavy job at a time)`);
    const granted = await acquireHeavySlot(key);
    s.queued = false;
    if (!granted || stopped || controller.signal.aborted) {
      s.controller = null;
      if (granted) releaseHeavySlot();
      return { status: "skipped", reason: stopped ? "stopped" : "cancelled" };
    }
    s.holdsSlot = true;
  }

  s.running = true;
  s.startedAt = new Date().toISOString();
  const startedAtIso = s.startedAt;
  const start = Date.now();
  const recordAtStart = def.scheduleType === "cron";
  const rowId = recordAtStart ? recordRunStart(key, startedAtIso) : Promise.resolve<number | null>(null);
  let failure: unknown = null;
  let value: T | undefined;

  try {
    value = runner ? await runner(controller.signal) : ((await def.run(controller.signal, { manual: options.manual === true })) as unknown as T);
    s.lastStatus = controller.signal.aborted ? "cancelled" : "success";
    s.lastError = null;
  } catch (err) {
    failure = err;
    s.lastStatus = "error";
    s.lastError = (err as Error).message;
    log.error(`[jobs] "${def.name}" failed:`, err);
  } finally {
    s.running = false;
    s.startedAt = null;
    s.controller = null;
    s.lastRunAt = new Date().toISOString();
    s.lastDurationMs = Date.now() - start;
    if (recordAtStart) recordRunEnd(rowId, s.lastStatus ?? "error", s.lastError, s.lastDurationMs);
    else if (s.lastStatus !== "success" || s.lastDurationMs > INTERVAL_RECORD_MS) recordFinishedRun(key, startedAtIso, s.lastStatus ?? "error", s.lastError, s.lastDurationMs);
    if (def.heavy && s.holdsSlot) {
      s.holdsSlot = false;
      releaseHeavySlot();
    }
  }
  if (failure !== null && throwOnError) throw failure;
  return { status: "ran", value: value as T };
}

/**
 * Runs `runner` as a run of job `key` and hands back what it returned. For the System page's "run now"
 * buttons (archival, Trakt sync, Plex watchlist sync), which used to call the job's code directly: a click
 * could then run beside the scheduled run of the same job (archival moves files), outside the heavy-job
 * queue and without leaving a history row. A failure is thrown to the caller after being recorded.
 */
export function runJobWithResult<T>(
  key: string,
  runner: (signal: AbortSignal) => Promise<T>,
  options: { immediate?: boolean } = {}
): Promise<ExecuteOutcome<T>> {
  return execute<T>(key, runner, true, options);
}

function startTask(key: string): void {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s || !s.enabled) return;

  if (def.scheduleType === "cron") {
    s.task = cron.schedule(s.schedule, () => {
      execute(key).catch(() => {});
    });
  } else {
    const seconds = Math.max(5, parseInt(s.schedule, 10) || parseInt(def.defaultSchedule, 10));
    s.task = setInterval(() => {
      execute(key).catch(() => {});
    }, seconds * 1000);
  }
}

function stopTask(key: string): void {
  const s = state.get(key);
  if (!s?.task) return;
  if ("stop" in s.task) s.task.stop();
  else clearInterval(s.task);
  s.task = null;
}

/** Starts every registered job on its currently configured (or default) schedule. */
export function startAllJobs(): void {
  stopped = false;
  for (const key of defs.keys()) startTask(key);
}

/** Stops every job's cron/interval timer and refuses any further run, "Run now" included, until
 * startAllJobs — used on shutdown and before a backup restore, alongside cancelJob for whatever's
 * already mid-run, so neither races a job that just started. */
export function stopAllJobs(): void {
  stopped = true;
  for (const key of defs.keys()) stopTask(key);
  wakeHeavyWaiters();
}

export function isJobsStopped(): boolean {
  return stopped;
}

export function isJobRunning(key: string): boolean {
  return state.get(key)?.running ?? false;
}

/** Running, or waiting for the heavy-job slot: either way a second trigger would be a duplicate. */
export function isJobBusy(key: string): boolean {
  const s = state.get(key);
  return !!s && (s.running || s.queued);
}

export type RunJobResult = "started" | "already-running" | "unknown" | "stopped";

export function runJobNow(key: string): RunJobResult {
  if (!defs.has(key)) return "unknown";
  if (stopped) return "stopped";
  if (isJobBusy(key)) return "already-running";
  execute(key, undefined, false, { manual: true }).catch(() => {});
  return "started";
}

/** A cancelled heavy job gets this long to stop before the slot is given to the next one. */
const CANCEL_GRACE_MS = 60_000;

export function cancelJob(key: string): boolean {
  const s = state.get(key);
  if (!s?.controller || !(s.running || s.queued)) return false;
  s.controller.abort();
  if (s.running && s.holdsSlot) {
    // Cancelling is best effort: a job that does not look at the signal, or sits in a call to a dead mount, would
    // otherwise keep the slot, and every other heavy job would wait behind it until a restart.
    const timer = setTimeout(() => {
      if (s.running && s.holdsSlot && heavyHolder === key) {
        log.warn(`[jobs] "${defs.get(key)?.name ?? key}" did not stop ${CANCEL_GRACE_MS / 1000}s after it was cancelled — letting the next heavy job start`);
        s.holdsSlot = false;
        releaseHeavySlot();
      }
    }, CANCEL_GRACE_MS);
    timer.unref?.();
  }
  if (s.queued) {
    // Not started yet: leave the queue (its waiter is woken with "not granted").
    const index = heavyWaiters.findIndex((w) => w.key === key);
    if (index >= 0) heavyWaiters.splice(index, 1)[0].wake(false);
  }
  return true;
}

export function updateJobSchedule(key: string, schedule: string): { ok: boolean; error?: string } {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s) return { ok: false, error: "Unknown job" };

  if (def.scheduleType === "cron" && !cron.validate(schedule)) {
    return { ok: false, error: "Invalid cron expression" };
  }
  if (def.scheduleType === "interval" && (!/^\d+$/.test(schedule) || Number(schedule) < 5)) {
    return { ok: false, error: "Interval must be a whole number of seconds, at least 5" };
  }

  stopTask(key);
  s.schedule = schedule;
  setSetting(settingKey(key), schedule);
  if (!stopped) startTask(key);
  return { ok: true };
}

/**
 * Switches a job on or off: a job that is off has no timer, is not caught up after a restart and is left out of
 * Health's "failing jobs"; "Run now" still runs it. The queue poll cannot be switched off. Sonarr switches a task
 * off by an interval of 0; here the schedule is kept, so switching it on again needs no retyping.
 */
export function setJobEnabled(key: string, enabled: boolean): { ok: boolean; error?: string } {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s) return { ok: false, error: "Unknown job" };
  if (def.essential && !enabled) return { ok: false, error: `"${def.name}" cannot be switched off: downloads would never be imported` };
  if (s.enabled === enabled) return { ok: true };
  stopTask(key);
  s.enabled = enabled;
  setSetting(enabledKey(key), enabled ? "1" : "0");
  if (enabled && !stopped) startTask(key);
  return { ok: true };
}

export interface JobStatus {
  key: string;
  name: string;
  scheduleType: "cron" | "interval";
  schedule: string;
  /** Switched on (see setJobEnabled). */
  enabled: boolean;
  /** Has no off switch. */
  essential: boolean;
  running: boolean;
  /** Waiting for the heavy-job slot behind another heavy job. */
  queued: boolean;
  /** The heavy job it is waiting behind. */
  waitingFor: string | null;
  heavy: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "cancelled" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
}

/** Computed on demand rather than cached — a cron job's "next run" only ever depends on its
 * expression and the current time, so there's nothing to invalidate by recomputing fresh on every
 * listJobs() call. An interval job's next run is only ever an estimate (interval jobs aren't
 * anchored to a fixed clock time the way cron ones are), based on its last run plus the interval;
 * a job that hasn't run yet since startup has no anchor to estimate from, so this returns null
 * rather than guess. */
function computeNextRunAt(def: JobDef, s: JobState): string | null {
  if (!s.enabled) return null;
  try {
    if (def.scheduleType === "cron") {
      return CronExpressionParser.parse(s.schedule).next().toDate().toISOString();
    }
    const seconds = Math.max(5, parseInt(s.schedule, 10) || parseInt(def.defaultSchedule, 10));
    if (!s.lastRunAt) return null;
    return new Date(new Date(s.lastRunAt).getTime() + seconds * 1000).toISOString();
  } catch {
    return null;
  }
}

export function listJobs(): JobStatus[] {
  return Array.from(defs.values()).map((def) => {
    const s = state.get(def.key)!;
    return {
      key: def.key,
      name: def.name,
      scheduleType: def.scheduleType,
      schedule: s.schedule,
      enabled: s.enabled,
      essential: !!def.essential,
      running: s.running,
      queued: s.queued,
      waitingFor: s.queued && heavyHolder !== null ? defs.get(heavyHolder)?.name ?? heavyHolder : null,
      heavy: !!def.heavy,
      startedAt: s.startedAt,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      lastDurationMs: s.lastDurationMs,
      nextRunAt: computeNextRunAt(def, s),
    };
  });
}

interface JobRunRow {
  id: number;
  job_key: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
}

/** Used to tell the runs of an earlier process (still "running" in job_runs) from this one's. */
const PROCESS_STARTED_AT = new Date().toISOString();
const INTERRUPTED = "Interrupted by a restart";

/**
 * Fills each registered job's last result from job_runs, so the Jobs page does not read "Never" after a restart. A run
 * still marked "running" from an earlier process was cut off: it is closed as an error with that reason first, so it
 * neither stays "running" for 30 days nor counts as a run that happened (see catchUpMissedJobs). A job that is
 * running in this process now is left as it is.
 */
export async function hydrateJobHistory(): Promise<void> {
  try {
    await db
      .prepare("UPDATE job_runs SET status = 'error', error = ?, finished_at = started_at WHERE status = 'running' AND started_at < ?")
      .run(INTERRUPTED, PROCESS_STARTED_AT);
  } catch {
    return; // no database yet (a test, or a start-up order problem): nothing to hydrate from
  }
  for (const [key, s] of state) {
    if (s.running) continue;
    try {
      const row = (await db
        .prepare("SELECT * FROM job_runs WHERE job_key = ? ORDER BY started_at DESC, id DESC LIMIT 1")
        .get(key)) as JobRunRow | undefined;
      if (!row) continue;
      s.hasHistory = true;
      const finished = (await db
        .prepare("SELECT MAX(started_at) AS at FROM job_runs WHERE job_key = ? AND NOT (status = 'error' AND error = ?)")
        .get(key, INTERRUPTED)) as { at: string | null } | undefined;
      s.lastFinishedAt = finished?.at ?? null;
      if (s.lastRunAt) continue;
      s.lastRunAt = row.finished_at ?? row.started_at;
      s.lastStatus = row.status as JobState["lastStatus"];
      s.lastError = row.error;
      s.lastDurationMs = row.duration_ms;
    } catch {
      return;
    }
  }
}

/** Catch-up delay: long enough that the first minutes after a restart are left to the admin, with a stagger so
 * several overdue jobs do not all start together (heavy ones queue anyway). */
const CATCH_UP_DELAY_MS = 2 * 60 * 1000;
const CATCH_UP_STAGGER_MS = 30 * 1000;
/** Catch-up is for jobs that run once a day or less often; one on a shorter schedule would run again after every restart. */
const CATCH_UP_MIN_PERIOD_MS = 20 * 60 * 60 * 1000;

/**
 * Jobs opted in with `catchUp` whose last completed run is older than their previous scheduled time. A run a restart
 * cut off does not count as completed (an update on a Sunday morning is exactly when that happens). A job with no
 * recorded run at all is left alone: on the first start after an upgrade nothing has history yet, and every weekly job
 * running at once would be worse than waiting for its normal time. Returns the keys it scheduled.
 */
export function catchUpMissedJobs(now = new Date()): string[] {
  const scheduled: string[] = [];
  for (const [key, def] of defs) {
    const s = state.get(key);
    if (!def.catchUp || def.scheduleType !== "cron" || !s || !s.hasHistory || !s.enabled) continue;
    let previous: Date;
    let period: number;
    try {
      previous = CronExpressionParser.parse(s.schedule, { currentDate: now }).prev().toDate();
      period = CronExpressionParser.parse(s.schedule, { currentDate: previous }).next().toDate().getTime() - previous.getTime();
    } catch {
      continue;
    }
    if (period < CATCH_UP_MIN_PERIOD_MS) continue;
    if (s.lastFinishedAt && new Date(s.lastFinishedAt).getTime() >= previous.getTime()) continue;
    const delay = CATCH_UP_DELAY_MS + scheduled.length * CATCH_UP_STAGGER_MS;
    scheduled.push(key);
    log.info(`[jobs] "${def.name}" missed its run at ${previous.toISOString()} (last completed ${s.lastFinishedAt ?? "never"}) — catching up in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      if (!stopped) execute(key).catch(() => {});
    }, delay);
    timer.unref?.();
  }
  return scheduled;
}

/** The failures must span at least this long: three failures of a job in a minute is a hiccup, not a pattern. */
const FAILING_MIN_SPAN_MS = 30 * 60 * 1000;

/**
 * Jobs whose last `threshold` finished runs all failed over at least half an hour (a cancelled run ends the streak),
 * for Health. Interval jobs are left out: only their failures are recorded, so "the last runs" is not known.
 */
export async function getFailingJobs(threshold = 3): Promise<{ key: string; name: string; failures: number; lastError: string | null }[]> {
  const out: { key: string; name: string; failures: number; lastError: string | null }[] = [];
  for (const [key, def] of defs) {
    // A job switched off is not failing: it is not running.
    if (def.scheduleType !== "cron" || state.get(key)?.enabled === false) continue;
    const rows = (await db
      .prepare("SELECT status, error, started_at FROM job_runs WHERE job_key = ? AND status != 'running' ORDER BY started_at DESC, id DESC LIMIT ?")
      .all(key, threshold)) as { status: string; error: string | null; started_at: string }[];
    if (rows.length !== threshold || !rows.every((r) => r.status === "error")) continue;
    const span = Date.parse(rows[0].started_at) - Date.parse(rows[rows.length - 1].started_at);
    if (Number.isFinite(span) && span < FAILING_MIN_SPAN_MS) continue;
    out.push({ key, name: def.name, failures: threshold, lastError: rows[0].error });
  }
  return out;
}

/** The newest runs of one job, newest first, for the Jobs page. */
export async function listJobRuns(key: string, limit = 30): Promise<JobRunRow[]> {
  return (await db
    .prepare("SELECT * FROM job_runs WHERE job_key = ? ORDER BY started_at DESC, id DESC LIMIT ?")
    .all(key, limit)) as JobRunRow[];
}

/** Whether the job's timer runs (a job switched off in the Jobs page still runs on "Run now"). Unknown keys read as off. */
export function isJobEnabled(key: string): boolean {
  return state.get(key)?.enabled ?? false;
}
