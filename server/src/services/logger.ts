export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];

function push(level: LogLevel, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  buffer.push({ level, message, timestamp: new Date().toISOString() });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

/** Thin wrapper around console.* that also keeps an in-memory ring buffer of the last 500 lines,
 * surfaced via GET /api/system/logs — so "what's been happening" is visible from the web UI
 * without needing `docker compose logs`. Still logs to stdout/stderr as before for anyone who
 * does want the container logs. */
export const log = {
  info(...args: unknown[]): void {
    console.log(...args);
    push("info", args);
  },
  warn(...args: unknown[]): void {
    console.warn(...args);
    push("warn", args);
  },
  error(...args: unknown[]): void {
    console.error(...args);
    push("error", args);
  },
};

export function getRecentLogs(): LogEntry[] {
  return [...buffer].reverse();
}
