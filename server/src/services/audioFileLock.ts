import path from "node:path";

/**
 * Which audio files are being rewritten right now, by a tag write or by an import that replaces the file. Both read the file,
 * build a new copy and rename it over the original, so two of them on one path can put the older bytes over the newer ones (a
 * retag that read the old file, an upgrade that replaced it, the retag's rename after it). In memory on purpose, like
 * titleMoveLock.ts: a restart ends every write, and a write that was cut off is simply run again.
 *
 * A tag write takes the lock without waiting and skips the file when it is taken (the next pass gets it); an import waits,
 * because it has the better file in hand and a retag of the file it replaces is over in seconds.
 */

/** How long an import waits for a retag of a file it replaces, and the most one file's tag write may hold an import up. */
export const IMPORT_TAG_LIMITS = {
  lockWaitMs: 60_000,
  fileTimeoutMs: 120_000,
};

interface Waiter {
  grant: () => void;
  /** The wait is over without the lock. */
  expire: () => void;
  timer: NodeJS.Timeout;
}

/** The held paths, each with the callers queued for it (the lock passes to the first of them when it is given back). */
const held = new Map<string, Waiter[]>();

function keyOf(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

export function isAudioFileLocked(filePath: string): boolean {
  return held.has(keyOf(filePath));
}

/** Takes the lock for a file; false when somebody holds it already. */
export function tryLockAudioFile(filePath: string): boolean {
  const key = keyOf(filePath);
  if (held.has(key)) return false;
  held.set(key, []);
  return true;
}

export function unlockAudioFile(filePath: string): void {
  const key = keyOf(filePath);
  const queue = held.get(key);
  if (!queue) return;
  const next = queue.shift();
  if (next) {
    // Handed over without being free in between: nobody else can slip in.
    clearTimeout(next.timer);
    next.grant();
  } else {
    held.delete(key);
  }
}

/** Takes the lock, waiting up to `waitMs` for whoever holds it; false when it was not got in that time. */
export function lockAudioFile(filePath: string, waitMs: number): Promise<boolean> {
  if (tryLockAudioFile(filePath)) return Promise.resolve(true);
  if (waitMs <= 0) return Promise.resolve(false);
  const queue = held.get(keyOf(filePath)) as Waiter[];
  return new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      grant: () => resolve(true),
      expire: () => resolve(false),
      timer: setTimeout(() => {
        const at = queue.indexOf(waiter);
        if (at >= 0) queue.splice(at, 1);
        resolve(false);
      }, waitMs),
    };
    waiter.timer.unref?.();
    queue.push(waiter);
  });
}

export interface HeldAudioFiles {
  /** Gives one of the files back (the import hands a file over to its tag write this way). */
  release(filePath: string): void;
  releaseAll(): void;
}

/**
 * Takes the locks of all of `filePaths` or none of them, waiting up to `totalWaitMs` in all. Null when some file could not be
 * got in time. Taken in one fixed order, so two callers with overlapping sets cannot hold one each and wait for the other.
 */
export async function lockAudioFiles(filePaths: string[], totalWaitMs: number): Promise<HeldAudioFiles | null> {
  const byKey = new Map<string, string>();
  for (const filePath of filePaths) byKey.set(keyOf(filePath), filePath);
  const order = [...byKey.keys()].sort();
  const deadline = Date.now() + totalWaitMs;
  const taken: string[] = [];
  for (const key of order) {
    if (!(await lockAudioFile(byKey.get(key) as string, Math.max(0, deadline - Date.now())))) {
      for (const done of taken) unlockAudioFile(byKey.get(done) as string);
      return null;
    }
    taken.push(key);
  }
  const open = new Set(taken);
  const giveBack = (key: string) => {
    if (open.delete(key)) unlockAudioFile(byKey.get(key) as string);
  };
  return {
    release: (filePath) => giveBack(keyOf(filePath)),
    releaseAll: () => {
      for (const key of [...open]) giveBack(key);
    },
  };
}

/**
 * Runs `work` for at most `limitMs`. When the time is up the signal it was given is aborted and the answer is null (the work
 * is left to wind down on its own: an aborted ffmpeg is killed, a write already under way finishes). Never throws for a late
 * failure of the work.
 */
export async function runWithin<T>(limitMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, limitMs);
  });
  const running = work(controller.signal);
  running.catch(() => {});
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: forget every lock. */
export function resetAudioFileLocksForTests(): void {
  for (const queue of held.values()) {
    for (const waiter of queue) {
      clearTimeout(waiter.timer);
      waiter.expire();
    }
  }
  held.clear();
}
