import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import type { Response } from "express";
import { config } from "../config.js";
import { getSetting } from "./settingsStore.js";
import { currentRequestId } from "./requestContext.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

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
/** A day's file is closed and the next numbered one started (`aonarr-<date>.1.log`) once it reaches this
 * size, so one log storm cannot grow a single file without bound (Sonarr rotates by size at 1 MB; this
 * is larger because AoNarr logs a whole day to one file and the web view downloads whole files). */
export const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
/** At most this many numbered files for one day (at 10 MB that is 200 MB a day): a runaway logger cannot fill the volume. */
export const MAX_LOG_FILES_PER_DAY = 20;
const LOG_FILE_PATTERN = /^aonarr-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
let currentLogDate = "";
let currentLogIndex = 0;
let currentLogBytes = 0;
let currentLogStream: fs.WriteStream | null = null;

function logFilePath(date: string, index = 0): string {
  return path.join(LOG_DIR, index === 0 ? `aonarr-${date}.log` : `aonarr-${date}.${index}.log`);
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
    const match = file.match(LOG_FILE_PATTERN);
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

/** Opens today's newest numbered file for appending: the highest existing index, or the next one when
 * that file is already full. */
function openLogFileFor(date: string): void {
  currentLogStream?.end();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let index = 0;
  try {
    for (const file of fs.readdirSync(LOG_DIR)) {
      const match = file.match(LOG_FILE_PATTERN);
      if (match && match[1] === date) index = Math.max(index, Number(match[2] ?? 0));
    }
  } catch {
    // unreadable directory: start from the base file name
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(logFilePath(date, index)).size;
  } catch {
    // no file yet
  }
  if (bytes >= MAX_LOG_FILE_BYTES) {
    index++;
    bytes = 0;
  }
  currentLogStream = fs.createWriteStream(logFilePath(date, index), { flags: "a" });
  currentLogDate = date;
  currentLogIndex = index;
  currentLogBytes = bytes;
}

function currentStream(nextWriteBytes: number): fs.WriteStream {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentLogDate) {
    openLogFileFor(today);
    pruneOldLogFiles();
  } else if (currentLogBytes > 0 && currentLogBytes + nextWriteBytes > MAX_LOG_FILE_BYTES) {
    currentLogStream?.end();
    currentLogIndex++;
    currentLogStream = fs.createWriteStream(logFilePath(today, currentLogIndex), { flags: "a" });
    currentLogBytes = 0;
    // Keep the newest MAX_LOG_FILES_PER_DAY: the oldest of the day goes (the base file first, then .1, .2 ...).
    const oldest = currentLogIndex - MAX_LOG_FILES_PER_DAY;
    if (oldest >= 0) {
      try {
        fs.unlinkSync(logFilePath(today, oldest));
      } catch {
        // already gone
      }
    }
  }
  return currentLogStream!;
}

/** Ends the log file stream and waits (at most `timeoutMs`) for the last lines to reach the disk. The
 * final "[shutdown] exiting" line used to be lost in every run because process.exit came straight after it. */
export function closeLogStream(timeoutMs = 2000): Promise<void> {
  const stream = currentLogStream;
  currentLogStream = null;
  currentLogDate = "";
  if (!stream) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    stream.end(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    .filter((f) => LOG_FILE_PATTERN.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(LOG_DIR, f));
      return { name: f, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => {
      const [ma, mb] = [a.name.match(LOG_FILE_PATTERN)!, b.name.match(LOG_FILE_PATTERN)!];
      return mb[1].localeCompare(ma[1]) || Number(mb[2] ?? 0) - Number(ma[2] ?? 0);
    });
}

/** Absolute path for a log filename already returned by listLogFiles() — validated against the
 * same strict filename pattern so this can't be used to escape LOG_DIR (e.g. "../../etc/passwd"). */
export function resolveLogFilePath(name: string): string | null {
  if (!LOG_FILE_PATTERN.test(name)) return null;
  return path.join(LOG_DIR, name);
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Radarr-style configurable log verbosity. "debug" is the most detailed level and is off by default:
 * it is only written (stdout, the in-memory buffer and the file) when the log level setting is "debug",
 * so a call site can carry detail for a diagnosis without costing anything in normal use. Below that,
 * the setting controls how much gets *persisted* (in-memory ring buffer + daily log file, both surfaced
 * via the System → Logs pages): "warn" drops routine info-level noise, "error" keeps only failures.
 * Info, warn and error always go to stdout/stderr regardless of this setting — `docker compose logs`
 * isn't affected, only what's kept for the web UI's own log views. Defaults to "info" when unset. */
function isPersisted(level: LogLevel): boolean {
  // getSetting() throws if called before loadSettingsCache() finishes at startup — very early
  // boot logging (before the DB/settings cache is even up) must never be lost over that, so it
  // defaults to "log everything" rather than let the throw escape from inside log.info/warn/error.
  let configured: LogLevel | null = null;
  try {
    configured = getSetting("logLevel") as LogLevel | null;
  } catch {
    return level !== "debug"; // before the settings are loaded nothing is lost, but debug is only for when it was asked for
  }
  const threshold = LEVEL_RANK[configured ?? "info"] ?? 1;
  return LEVEL_RANK[level] >= threshold;
}

/** Radarr/Sonarr-style live-tailing System → Logs page (see routes/system.ts's GET /logs/stream) —
 * a Set of open SSE connections that get every new entry pushed to them as it's logged, the same
 * "register on connect, write until the client disconnects" pattern services/realtime.ts already
 * uses for the Activity queue. Kept here rather than in realtime.ts since it's tightly coupled to
 * this module's own buffer/push() — realtime.ts stays queue-specific. */
const streamClients = new Set<Response>();

export function registerLogStreamClient(res: Response): void {
  streamClients.add(res);
}

export function unregisterLogStreamClient(res: Response): void {
  streamClients.delete(res);
}

function broadcast(entry: LogEntry): void {
  if (streamClients.size === 0) return;
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const res of streamClients) {
    try {
      res.write(payload);
    } catch {
      // a write to a half-closed connection — the client's own "close" handler unregisters it
    }
  }
}

/** One log argument as text. JSON.stringify throws on a circular object and returns undefined for a function
 * or a bare undefined; a log call must never turn into a second error, so those fall back to util.inspect. */
function formatLogArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    const json = JSON.stringify(a);
    if (json !== undefined) return json;
  } catch {
    // circular or otherwise not serializable
  }
  return inspect(a, { depth: 4, breakLength: Infinity });
}

function push(level: LogLevel, args: unknown[]): boolean {
  if (!isPersisted(level)) return false;
  const message = args.map(formatLogArg).join(" ");
  const timestamp = new Date().toISOString();
  const entry: LogEntry = { level, message, timestamp };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  try {
    const line = `[${timestamp}] ${level.toUpperCase()} ${message}\n`;
    currentStream(Buffer.byteLength(line)).write(line);
    currentLogBytes += Buffer.byteLength(line);
  } catch {
    // disk full / permissions issue writing the log file shouldn't break the app — the in-memory
    // buffer and stdout/stderr below still carry the message either way
  }
  broadcast(entry);
  return true;
}

/** Prepends `[reqId]` to a log call's args when made while handling a request (see
 * requestContext.ts) — so every log line touched by one HTTP request, no matter how deep the
 * call chain into services, can be grepped out of a busy log file by that one tag. Background
 * jobs and startup logging have no request context, so they're unaffected (no tag added). */
function withReqTag(args: unknown[]): unknown[] {
  const reqId = currentRequestId();
  return reqId ? [`[${reqId}]`, ...args] : args;
}

/** Thin wrapper around console.* that also keeps an in-memory ring buffer of the last MAX_ENTRIES
 * lines, surfaced via GET /api/system/logs — so "what's been happening" is visible from the web UI
 * without needing `docker compose logs`. Still logs to stdout/stderr as before for anyone who
 * does want the container logs, and now also to a daily rotating file under <configDir>/logs
 * (see listLogFiles/resolveLogFilePath) so history survives a restart. */
export const log = {
  debug(...args: unknown[]): void {
    // Only when the setting is "debug": nothing is printed or kept otherwise.
    const tagged = withReqTag(args);
    if (push("debug", tagged)) console.debug(...tagged);
  },
  info(...args: unknown[]): void {
    const tagged = withReqTag(args);
    console.log(...tagged);
    push("info", tagged);
  },
  warn(...args: unknown[]): void {
    const tagged = withReqTag(args);
    console.warn(...tagged);
    push("warn", tagged);
  },
  error(...args: unknown[]): void {
    const tagged = withReqTag(args);
    console.error(...tagged);
    push("error", tagged);
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
