import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

const MAX_ENTRIES = 2000;
const buffer: LogEntry[] = [];

/** Radarr-style persistent log files (System → Log Files) — the in-memory ring buffer above is
 * fast for the live "recent logs" view but resets on every container restart, which previously
 * left the web UI with nothing after a crash-and-restart even though that's exactly when you'd
 * want to see what happened. One file per calendar day under <configDir>/logs, retained for
 * LOG_RETENTION_DAYS and pruned opportunistically on startup and on each day rollover. */
const LOG_DIR = path.join(config.configDir, "logs");
const LOG_RETENTION_DAYS = 7;
let currentLogDate = "";
let currentLogStream: fs.WriteStream | null = null;

function logFilePath(date: string): string {
  return path.join(LOG_DIR, `aonarr-${date}.log`);
}

function pruneOldLogFiles(): void {
  let files: string[];
  try {
    files = fs.readdirSync(LOG_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of files) {
    const match = file.match(/^aonarr-(\d{4}-\d{2}-\d{2})\.log$/);
    if (!match) continue;
    if (Date.parse(match[1]) < cutoff) {
      try {
        fs.unlinkSync(path.join(LOG_DIR, file));
      } catch {
        // best-effort cleanup — a locked/already-gone file just stays until the next prune
      }
    }
  }
}

function currentStream(): fs.WriteStream {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentLogDate) {
    currentLogStream?.end();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    currentLogStream = fs.createWriteStream(logFilePath(today), { flags: "a" });
    currentLogDate = today;
    pruneOldLogFiles();
  }
  return currentLogStream!;
}

/** Every file matching the retention window, newest first — for the System → Log Files list. */
export function listLogFiles(): { name: string; sizeBytes: number; modifiedAt: string }[] {
  let files: string[];
  try {
    files = fs.readdirSync(LOG_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^aonarr-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(LOG_DIR, f));
      return { name: f, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Absolute path for a log filename already returned by listLogFiles() — validated against the
 * same strict filename pattern so this can't be used to escape LOG_DIR (e.g. "../../etc/passwd"). */
export function resolveLogFilePath(name: string): string | null {
  if (!/^aonarr-\d{4}-\d{2}-\d{2}\.log$/.test(name)) return null;
  return path.join(LOG_DIR, name);
}

function push(level: LogLevel, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const timestamp = new Date().toISOString();
  buffer.push({ level, message, timestamp });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  try {
    currentStream().write(`[${timestamp}] ${level.toUpperCase()} ${message}\n`);
  } catch {
    // disk full / permissions issue writing the log file shouldn't break the app — the in-memory
    // buffer and stdout/stderr below still carry the message either way
  }
}

/** Thin wrapper around console.* that also keeps an in-memory ring buffer of the last 500 lines,
 * surfaced via GET /api/system/logs — so "what's been happening" is visible from the web UI
 * without needing `docker compose logs`. Still logs to stdout/stderr as before for anyone who
 * does want the container logs, and now also to a daily rotating file under <configDir>/logs
 * (see listLogFiles/resolveLogFilePath) so history survives a restart. */
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

export interface LogFilter {
  level?: LogLevel;
  search?: string;
  since?: string;
}

export function getRecentLogs(filter: LogFilter = {}): LogEntry[] {
  let entries = [...buffer].reverse();
  if (filter.level) entries = entries.filter((e) => e.level === filter.level);
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    entries = entries.filter((e) => e.message.toLowerCase().includes(needle));
  }
  if (filter.since) {
    const sinceMs = Date.parse(filter.since);
    if (!Number.isNaN(sinceMs)) entries = entries.filter((e) => Date.parse(e.timestamp) >= sinceMs);
  }
  return entries;
}
