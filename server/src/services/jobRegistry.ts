import cron from "node-cron";
import { log } from "./logger.js";
import { getSetting, setSetting } from "./settingsStore.js";

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
  run: (signal: AbortSignal) => Promise<void>;
}

interface JobState {
  schedule: string;
  task: cron.ScheduledTask | ReturnType<typeof setInterval> | null;
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "cancelled" | null;
  lastError: string | null;
  lastDurationMs: number | null;
  controller: AbortController | null;
}

const defs = new Map<string, JobDef>();
const state = new Map<string, JobState>();

function settingKey(key: string): string {
  return `jobSchedule_${key}`;
}

export function registerJob(def: JobDef): void {
  defs.set(def.key, def);
  const schedule = getSetting(settingKey(def.key)) || def.defaultSchedule;
  state.set(def.key, {
    schedule,
    task: null,
    running: false,
    startedAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    controller: null,
  });
}

async function execute(key: string): Promise<void> {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s) return;
  if (s.running) {
    log.info(`[jobs] "${def.name}" is already running — skipping this trigger`);
    return;
  }

  const controller = new AbortController();
  s.running = true;
  s.startedAt = new Date().toISOString();
  s.controller = controller;
  const start = Date.now();

  try {
    await def.run(controller.signal);
    s.lastStatus = controller.signal.aborted ? "cancelled" : "success";
    s.lastError = null;
  } catch (err) {
    s.lastStatus = "error";
    s.lastError = (err as Error).message;
    log.error(`[jobs] "${def.name}" failed:`, err);
  } finally {
    s.running = false;
    s.startedAt = null;
    s.controller = null;
    s.lastRunAt = new Date().toISOString();
    s.lastDurationMs = Date.now() - start;
  }
}

function startTask(key: string): void {
  const def = defs.get(key);
  const s = state.get(key);
  if (!def || !s) return;

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
  for (const key of defs.keys()) startTask(key);
}

export function runJobNow(key: string): boolean {
  if (!defs.has(key)) return false;
  execute(key).catch(() => {});
  return true;
}

export function cancelJob(key: string): boolean {
  const s = state.get(key);
  if (!s?.running || !s.controller) return false;
  s.controller.abort();
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
  startTask(key);
  return { ok: true };
}

export interface JobStatus {
  key: string;
  name: string;
  scheduleType: "cron" | "interval";
  schedule: string;
  running: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "cancelled" | null;
  lastError: string | null;
  lastDurationMs: number | null;
}

export function listJobs(): JobStatus[] {
  return Array.from(defs.values()).map((def) => {
    const s = state.get(def.key)!;
    return {
      key: def.key,
      name: def.name,
      scheduleType: def.scheduleType,
      schedule: s.schedule,
      running: s.running,
      startedAt: s.startedAt,
      lastRunAt: s.lastRunAt,
      lastStatus: s.lastStatus,
      lastError: s.lastError,
      lastDurationMs: s.lastDurationMs,
    };
  });
}
