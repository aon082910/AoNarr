import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One AoNarr per /config. Two processes on the same SQLite file run every job twice, race on imports and can corrupt
 * the database (Starr's host has a SingleInstancePolicy for the same reason). A lock file in the config folder holds
 * the holder's id and the time of its last heartbeat; a live instance rewrites it every few seconds, one that crashed
 * stops, and a clean exit removes it. A second start looks at the file for one heartbeat: if it moves, the holder is
 * alive and the new process refuses to start; if it does not, the holder is gone and the lock is taken over, so a
 * crash followed by a restart waits one heartbeat, not a timeout.
 *
 * Synchronous on purpose: it has to finish before the database module is loaded (startupGuard.ts is imported first).
 */

export const LOCK_FILE_NAME = "aonarr.lock";
export const HEARTBEAT_MS = 10_000;
/** How long a start watches a fresh lock for a heartbeat: one beat and a margin. */
export const OBSERVE_MS = HEARTBEAT_MS + 3_000;
/** A lock this old has no live holder (three missed beats), so a start does not wait on it. */
const STALE_MS = HEARTBEAT_MS * 3;

export interface LockRecord {
  id: string;
  pid: number;
  host: string;
  /** Milliseconds since the epoch, as the holder's clock read at its last heartbeat. */
  at: number;
}

export type LockResult = { ok: true; id: string } | { ok: false; holder: LockRecord };

export interface LockOptions {
  instanceId?: string;
  /** Test hooks. */
  now?: () => number;
  sleep?: (ms: number) => void;
  observeMs?: number;
  pollMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

function readLock(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<LockRecord>;
    if (typeof parsed.id !== "string" || typeof parsed.at !== "number") return null;
    return { id: parsed.id, pid: Number(parsed.pid) || 0, host: String(parsed.host ?? ""), at: parsed.at };
  } catch {
    return null;
  }
}

/** Written beside the lock and renamed over it, so a reader never sees half a file. */
function writeLock(file: string, record: LockRecord): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, file);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but is not ours to signal
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A holder on this very host whose process no longer exists, or whose process id is ours (a container restarted
 * under the same name starts over at the same pid): its lock is a leftover, and the start need not wait a heartbeat.
 */
function holderIsGone(holder: LockRecord, isAlive: (pid: number) => boolean): boolean {
  if (holder.host !== os.hostname() || !holder.pid) return false;
  return holder.pid === process.pid || !isAlive(holder.pid);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireInstanceLock(dir: string, options: LockOptions = {}): LockResult {
  const file = path.join(dir, LOCK_FILE_NAME);
  const id = options.instanceId ?? crypto.randomUUID();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepSync;
  const pollMs = options.pollMs ?? 1_000;
  const existing = readLock(file);
  if (existing && existing.id !== id && now() - existing.at < STALE_MS && !holderIsGone(existing, options.isProcessAlive ?? processIsAlive)) {
    const deadline = now() + (options.observeMs ?? OBSERVE_MS);
    while (now() < deadline) {
      sleep(pollMs);
      const again = readLock(file);
      // Removed: the holder left cleanly. Anything else that moved: it is alive.
      if (!again) break;
      if (again.id !== existing.id || again.at !== existing.at) return { ok: false, holder: again };
    }
  }
  writeLock(file, { id, pid: process.pid, host: os.hostname(), at: now() });
  return { ok: true, id };
}

/**
 * Keeps the lock fresh. When the file shows another instance (two starts raced, or the file was replaced), `onLost`
 * is called with it. Returns the function that stops the beat.
 */
export function startInstanceHeartbeat(dir: string, id: string, onLost: (holder: LockRecord) => void, intervalMs = HEARTBEAT_MS): () => void {
  const file = path.join(dir, LOCK_FILE_NAME);
  const timer = setInterval(() => {
    try {
      const current = readLock(file);
      if (current && current.id !== id) {
        onLost(current);
        return;
      }
      writeLock(file, { id, pid: process.pid, host: os.hostname(), at: Date.now() });
    } catch {
      // a full or read-only /config is the database's problem to report, not a reason to stop
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Removes the lock when it is still ours. */
export function releaseInstanceLock(dir: string, id: string): void {
  const file = path.join(dir, LOCK_FILE_NAME);
  try {
    if (readLock(file)?.id === id) fs.rmSync(file, { force: true });
  } catch {
    // nothing to do
  }
}
