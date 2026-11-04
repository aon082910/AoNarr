/**
 * The process carries on after an uncaught exception or an unhandled rejection (index.ts explains why: a crash loop
 * hides the cause and the in-app log is lost with the process). Carrying on leaves the process in a state nobody
 * checked, so these are counted: /metrics and the System status show the count, and Health warns when they come in
 * a run. Starr ends the process instead and lets its supervisor restart it.
 */

interface UncaughtEvent {
  at: number;
  kind: "exception" | "rejection";
  message: string;
}

const HOUR_MS = 3_600_000;
/** More than this in an hour is a pattern, not a one-off. */
export const UNCAUGHT_WARN_PER_HOUR = 3;
const KEEP = 200;

const events: UncaughtEvent[] = [];
let total = 0;

export function recordUncaughtError(kind: UncaughtEvent["kind"], err: unknown, now = Date.now()): void {
  total++;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  events.push({ at: now, kind, message });
  if (events.length > KEEP) events.splice(0, events.length - KEEP);
}

export interface UncaughtErrorStats {
  /** Since the process started. */
  total: number;
  lastHour: number;
  lastAt: string | null;
  lastMessage: string | null;
}

export function uncaughtErrorStats(now = Date.now()): UncaughtErrorStats {
  const last = events[events.length - 1];
  return {
    total,
    lastHour: events.filter((e) => now - e.at < HOUR_MS).length,
    lastAt: last ? new Date(last.at).toISOString() : null,
    lastMessage: last?.message ?? null,
  };
}

export function __resetUncaughtErrorsForTests(): void {
  events.length = 0;
  total = 0;
}
