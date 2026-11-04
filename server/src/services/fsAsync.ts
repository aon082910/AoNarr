import fs from "node:fs";
import path from "node:path";

/**
 * Helpers for the library-wide jobs and the status pages that touch the disk.
 *
 * Two things stop the whole server, not just one feature:
 *  - a loop that mixes synchronous file calls with awaited SQL never gives the event loop a turn,
 *    because the SQLite wrapper resolves every await in the same tick (150,000 rows took 680 ms to
 *    2 s with zero timer ticks). `createYielder` gives the loop a turn every few milliseconds.
 *  - a synchronous file call on a mount that hangs (a dead NFS/SMB share, a FUSE user share) never
 *    returns, so the process is stuck with it. The async calls below run on the libuv thread pool and
 *    are raced against a timeout, so the event loop stays free and the caller gets an answer.
 */

/** Long enough for a spun-down array disk to wake (10 to 15 s), short enough to notice a dead mount. */
export const FS_CALL_TIMEOUT_MS = 30_000;

export class StorageTimeoutError extends Error {
  constructor(public readonly target: string, ms: number) {
    super(`The storage at "${target}" did not answer within ${Math.round(ms / 1000)}s`);
    this.name = "StorageTimeoutError";
  }
}

/** A call that loses the race keeps its libuv thread for as long as the mount hangs, and the pool has 4 by
 * default (the Dockerfiles raise it to 16). So the same call is never issued twice while one is pending, and
 * for a minute after a timeout the same call fails at once instead of taking another thread. */
const TIMEOUT_REMEMBERED_MS = 60_000;
const pending = new Map<string, Promise<unknown>>();
const recentTimeouts = new Map<string, number>();

/** Test-only: forget pending calls and remembered timeouts. */
export function resetFsAsyncStateForTests(): void {
  pending.clear();
  recentTimeouts.clear();
}

function guardedCall<T>(operation: string, target: string, ms: number, start: () => Promise<T>): Promise<T> {
  const key = `${operation}:${target}`;
  const failedAt = recentTimeouts.get(key);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < TIMEOUT_REMEMBERED_MS) return Promise.reject(new StorageTimeoutError(target, ms));
    recentTimeouts.delete(key);
  }
  let call = pending.get(key) as Promise<T> | undefined;
  if (!call) {
    const started = start();
    call = started;
    pending.set(key, started);
    const forget = () => {
      if (pending.get(key) === started) pending.delete(key);
    };
    started.then(forget, forget);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (recentTimeouts.size > 1000) recentTimeouts.clear();
      recentTimeouts.set(key, Date.now());
      reject(new StorageTimeoutError(target, ms));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/** Runs one file call without blocking the event loop, with the pending-call and timeout rules above.
 * `operation` names the call kind in the cache key, so two different calls on one path stay separate. */
export function guardedFsCall<T>(operation: string, target: string, timeoutMs: number, start: () => Promise<T>): Promise<T> {
  return guardedCall(operation, target, timeoutMs, start);
}

/** `fs.promises.stat` (follows symlinks) with the timeout rules above. Rejects with the fs error for a
 * missing path; throws StorageTimeoutError for a mount that does not answer. */
export function statAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<fs.Stats> {
  return guardedCall("stat", target, timeoutMs, () => fs.promises.stat(target));
}

/** `fs.promises.lstat` (does not follow symlinks) with the timeout rules above. */
export function lstatAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<fs.Stats> {
  return guardedCall("lstat", target, timeoutMs, () => fs.promises.lstat(target));
}

/** The entries of a directory with their types, with the timeout rules above (the same call a library scan makes). */
export function readdirAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<fs.Dirent[]> {
  return guardedCall("readdir", target, timeoutMs, () => fs.promises.readdir(target, { withFileTypes: true }));
}

/** The names in a directory, with the timeout rules above. */
export function readdirNamesAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<string[]> {
  return guardedCall("readdir-names", target, timeoutMs, () => fs.promises.readdir(target));
}

/**
 * The total size of the files under `dir` (symlinks are not followed), counted without blocking and within bounds:
 * at most `maxEntries` entries and `budgetMs` in all. `complete` is false when a bound was hit or part of the tree
 * did not answer, in which case `bytes` is what was counted so far.
 */
export async function directorySizeAsync(dir: string, options: { maxEntries?: number; budgetMs?: number } = {}): Promise<{ bytes: number; complete: boolean }> {
  const maxEntries = options.maxEntries ?? 50_000;
  const deadline = Date.now() + (options.budgetMs ?? 10_000);
  const remaining = () => Math.max(1, Math.min(FS_CALL_TIMEOUT_MS, deadline - Date.now()));
  let bytes = 0;
  let seen = 0;
  let complete = true;
  const pendingDirs = [dir];
  while (pendingDirs.length > 0) {
    if (Date.now() >= deadline) return { bytes, complete: false };
    const current = pendingDirs.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await readdirAsync(current, remaining());
    } catch (err) {
      if (err instanceof StorageTimeoutError) return { bytes, complete: false };
      complete = false; // unreadable: its files are not counted
      continue;
    }
    for (let i = 0; i < entries.length; i += 16) {
      const batch = entries.slice(i, i + 16);
      seen += batch.length;
      if (seen > maxEntries) return { bytes, complete: false };
      const sizes = await Promise.all(
        batch.map(async (entry) => {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            pendingDirs.push(full);
            return 0;
          }
          if (!entry.isFile()) return 0;
          try {
            return (await lstatAsync(full, remaining())).size;
          } catch (err) {
            complete = false;
            if (err instanceof StorageTimeoutError) pendingDirs.length = 0;
            return 0;
          }
        })
      );
      for (const size of sizes) bytes += size;
    }
  }
  return { bytes, complete };
}

/** `fs.existsSync` without blocking: any error other than a timeout reads as "not there", as before.
 * Throws StorageTimeoutError when the mount does not answer, which is not the same as "missing". */
export async function pathExistsAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<boolean> {
  try {
    await guardedCall("access", target, timeoutMs, () => fs.promises.access(target));
    return true;
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return false;
  }
}

/** `fs.statfsSync` without blocking, or null when the call fails. Throws StorageTimeoutError on a hang. */
export async function statfsAsync(target: string, timeoutMs = FS_CALL_TIMEOUT_MS): Promise<fs.StatsFs | null> {
  try {
    return await guardedCall("statfs", target, timeoutMs, () => fs.promises.statfs(target));
  } catch (err) {
    if (err instanceof StorageTimeoutError) throw err;
    return null;
  }
}

/**
 * For a loop that runs many awaited steps without waiting for real I/O. Call the returned function
 * once per iteration: it does nothing until `sliceMs` have passed since the last turn it gave, then
 * waits one setImmediate so timers, HTTP, SSE and the health check get to run.
 */
export function createYielder(sliceMs = 20): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    if (performance.now() - sliceStart < sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    sliceStart = performance.now();
  };
}
