import fs from "node:fs";
import path from "node:path";

/**
 * The way back from a restore that does not start. A restore swaps the live SQLite file for the uploaded one and exits;
 * the previous file waits beside it as `<db>.pre-restore`. Before this, a restored file that opened but broke the
 * app at start-up (a migration it could not take, a table the code needs missing) left the container restarting for
 * ever, and the admin had to find the .pre-restore file and move it by hand (Starr keeps the old file aside until the
 * new one has started cleanly). Now the restore leaves a marker; every start counts itself in the marker before the
 * database is opened; a start that reaches "listening" removes the marker. A third start that finds the count at two
 * puts the previous database (and its encryption key) back and leaves the failed one aside.
 *
 * Plain fs on purpose: it runs before anything opens the database or loads the encryption key, and has no
 * dependencies that could fail with the file it is guarding.
 */
export const MAX_FAILED_RESTORE_STARTS = 2;

const PENDING_NAME = "restore-pending.json";
const NOTICE_NAME = "restore-rolled-back.json";

export interface RestoreFiles {
  dbPath: string;
  keyPath: string;
}

interface PendingRestore {
  at: string;
  starts: number;
}

export interface RolledBackNotice {
  at: string;
  failedDatabase: string;
  startsTried: number;
}

function pendingPath(files: RestoreFiles): string {
  return path.join(path.dirname(files.dbPath), PENDING_NAME);
}

function noticePath(files: RestoreFiles): string {
  return path.join(path.dirname(files.dbPath), NOTICE_NAME);
}

export function failedRestoreSuffix(): string {
  return ".failed-restore";
}

/** Called by the restore after the new file is in place: the next starts are on probation. */
export function markRestorePending(files: RestoreFiles): void {
  const pending: PendingRestore = { at: new Date().toISOString(), starts: 0 };
  fs.writeFileSync(pendingPath(files), JSON.stringify(pending));
  try {
    fs.rmSync(noticePath(files), { force: true });
  } catch {
    // an old notice stays until it expires on its own
  }
}

function readPending(files: RestoreFiles): PendingRestore | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingPath(files), "utf-8")) as Partial<PendingRestore>;
    return { at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(), starts: Number.isInteger(parsed.starts) ? Number(parsed.starts) : 0 };
  } catch {
    return null;
  }
}

function moveAside(file: string, target: string): void {
  fs.rmSync(target, { force: true });
  try {
    fs.renameSync(file, target);
  } catch {
    fs.copyFileSync(file, target);
    fs.rmSync(file, { force: true });
  }
}

export type RestoreStartVerdict = "none" | "on-probation" | "rolled-back" | "no-way-back";

/**
 * Run at the very start, before the database is opened. Counts this start while a restore is on probation; at the
 * third start with no clean one between, swaps the previous database back. Never throws: a guard that could stop the
 * app from starting would be worse than the problem it guards against.
 */
export function checkRestoreAtStart(files: RestoreFiles, log: (message: string) => void = console.error): RestoreStartVerdict {
  try {
    const pending = readPending(files);
    if (!pending) return "none";
    if (pending.starts < MAX_FAILED_RESTORE_STARTS) {
      fs.writeFileSync(pendingPath(files), JSON.stringify({ ...pending, starts: pending.starts + 1 }));
      return "on-probation";
    }
    const previousDb = `${files.dbPath}.pre-restore`;
    if (!fs.existsSync(previousDb)) {
      log(`[startup] The restored database failed to start ${pending.starts} times, but there is no ${previousDb} to put back. Fix or replace ${files.dbPath} by hand.`);
      fs.rmSync(pendingPath(files), { force: true });
      return "no-way-back";
    }
    const failedDb = `${files.dbPath}${failedRestoreSuffix()}`;
    // The previous database is copied to a temporary name first: a copy that fails (a full disk) then leaves the
    // restored file where it was and nothing is lost, instead of a missing database and the restored copy deleted
    // by the next attempt's move-aside.
    const staged = `${files.dbPath}.rollback-tmp`;
    try {
      fs.copyFileSync(previousDb, staged);
      moveAside(files.dbPath, failedDb);
      for (const suffix of ["-wal", "-shm"]) fs.rmSync(files.dbPath + suffix, { force: true });
      fs.renameSync(staged, files.dbPath);
    } catch (err) {
      // Failing after the restored file was moved aside: the staged copy (or the .pre-restore one) must still end up
      // at the database path, never a missing database.
      if (!fs.existsSync(files.dbPath)) {
        try {
          if (fs.existsSync(staged)) fs.renameSync(staged, files.dbPath);
          else fs.copyFileSync(previousDb, files.dbPath);
        } catch {
          // nothing more to try; the outer handler reports the original error
        }
      }
      fs.rmSync(staged, { force: true });
      throw err;
    }
    // The credentials in the previous database only open with the key it had.
    const previousKey = `${files.keyPath}.pre-restore`;
    if (fs.existsSync(previousKey)) {
      if (fs.existsSync(files.keyPath)) moveAside(files.keyPath, `${files.keyPath}${failedRestoreSuffix()}`);
      fs.copyFileSync(previousKey, files.keyPath);
      try {
        fs.chmodSync(files.keyPath, 0o600);
      } catch {
        // not every filesystem has modes
      }
    }
    const notice: RolledBackNotice = { at: new Date().toISOString(), failedDatabase: failedDb, startsTried: pending.starts };
    fs.writeFileSync(noticePath(files), JSON.stringify(notice));
    fs.rmSync(pendingPath(files), { force: true });
    log(
      `[startup] The restored database did not start ${pending.starts} times in a row, so the previous database was put back. ` +
        `The restored file is kept as ${failedDb} (the previous encryption key was put back too).`
    );
    return "rolled-back";
  } catch (err) {
    log(`[startup] Could not check the restore marker: ${(err as Error).message}`);
    return "none";
  }
}

/** The app is listening: the restored database works, so the probation ends. */
export function confirmRestoreStarted(files: RestoreFiles): void {
  try {
    fs.rmSync(pendingPath(files), { force: true });
  } catch {
    // a marker that cannot be removed only makes a later crash look like a failed restore
  }
}

/** The notice an automatic swap-back left, for Health; null once it is older than `days` or when there is none. */
export function readRolledBackNotice(files: RestoreFiles, days = 7): RolledBackNotice | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(noticePath(files), "utf-8")) as RolledBackNotice;
    const ageDays = (Date.now() - Date.parse(parsed.at)) / (24 * 60 * 60 * 1000);
    return Number.isFinite(ageDays) && ageDays < days ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A start that was stopped on purpose (SIGTERM, a deliberate restart) before it reached "listening" did not fail:
 * it is not held against the restored database. A start killed outright still counts.
 */
export function uncountRestoreStart(files: RestoreFiles): void {
  try {
    const pending = readPending(files);
    if (pending && pending.starts > 0) fs.writeFileSync(pendingPath(files), JSON.stringify({ ...pending, starts: pending.starts - 1 }));
  } catch {
    // the marker is only a safety net
  }
}
